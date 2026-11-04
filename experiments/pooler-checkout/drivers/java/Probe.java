// PC08 probe: pgjdbc behind HikariCP against one Postgres path.
//
// Run by tests/pc08-pgjdbc-hikari.ts inside the pinned JDK image with the
// pinned jars in /w/lib (lib/java.ts):
//   java -cp '/w/lib/*' /w/Probe.java
// Every setting comes from the environment, the password included (PGPASSWORD),
// so nothing secret is on the container's or the JVM's command line.
//
// MODE=defaults  print driver and pool defaults, no network.
// MODE=ping      one connection, `select 1`, exit 0 on success.
// MODE=workload  INSTANCES Hikari pools ("app instances") of POOL_SIZE, WORKERS
//                threads per pool, each looping ITERATIONS times over: a
//                parameterised point SELECT, an UPDATE ... RETURNING in an
//                explicit transaction, a 5-row batch INSERT in an explicit
//                transaction. One connection borrow per operation.
// MODE=hold      INSTANCES x WORKERS threads each borrow a connection and run
//                HOLD_SQL (a literal `select pg_sleep(n)`) HOLD_REPEAT times,
//                then borrow once more for a follow-up `select 1`.
//
// Output: JSON lines on stdout ({"e":"config"}, {"e":"start"}, {"e":"summary"}).
// Hikari's own WARN/ERROR lines go to stderr through slf4j-simple.
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import com.zaxxer.hikari.metrics.IMetricsTracker;
import java.io.PrintWriter;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Logger;
import javax.sql.DataSource;
import org.postgresql.PGConnection;
import org.postgresql.ds.PGSimpleDataSource;
import org.postgresql.jdbc.PreferQueryMode;

public class Probe {
  static String env(String k, String d) {
    String v = System.getenv(k);
    return v == null || v.isEmpty() ? d : v;
  }

  static int envInt(String k, int d) {
    return Integer.parseInt(env(k, String.valueOf(d)));
  }

  static final String MODE = env("MODE", "workload");
  static final int INSTANCES = envInt("INSTANCES", 4);
  static final int POOL = envInt("POOL_SIZE", 10);
  static final int WORKERS = envInt("WORKERS", POOL);
  static final int ITER = envInt("ITERATIONS", 500);
  static final long MAX_WALL_MS = Long.parseLong(env("MAX_WALL_MS", "600000"));
  static final long FILL_WAIT_MS = Long.parseLong(env("FILL_WAIT_MS", "20000"));
  static final int ITEMS = envInt("ITEMS", 10000);
  static final String PT = env("PREPARE_THRESHOLD", "");
  static final String QM = env("QUERY_MODE", "");
  static final String CONN_TIMEOUT = env("CONNECTION_TIMEOUT_MS", "");
  static final String HOLD_SQL = env("HOLD_SQL", "select pg_sleep(1)");
  static final int HOLD_REPEAT = envInt("HOLD_REPEAT", 1);
  /** pgjdbc socketTimeout in seconds; empty = the driver default (0, wait forever). */
  static final String SOCKET_TIMEOUT_S = env("SOCKET_TIMEOUT_S", "");

  static final String SEL = "select id, k, v, 'sel' as tag, pg_backend_pid() as pid from pc08_items where id = ?";
  static final String UPD = "update pc08_items set k = k + 1, v = ? where id = ? returning id, 'upd' as tag";
  static final String INS = "insert into pc08_events (item_id, note) values (?, ?)";

  static volatile long workStart = System.nanoTime();

  static long sinceStartMs() {
    return (System.nanoTime() - workStart) / 1_000_000;
  }

  static double ms(long nanos) {
    return Math.round(nanos / 1e4) / 100.0;
  }

  // ---------- error bookkeeping
  static final class ErrStat {
    long count;
    String example;
    long firstAtMs;
    double minMs = Double.MAX_VALUE;
    double maxMs;
  }

  static final ConcurrentHashMap<String, ErrStat> ERRORS = new ConcurrentHashMap<>();
  static final AtomicLong FIRST_ERROR_AT = new AtomicLong(-1);

  static String norm(String s) {
    return s == null ? "" : s.replaceAll("\\s+", " ").trim();
  }

  static String describe(Throwable t) {
    StringBuilder b = new StringBuilder();
    Throwable c = t;
    for (int depth = 0; c != null && depth < 3; depth++, c = c.getCause()) {
      if (depth > 0) b.append(" <- cause ");
      b.append(c.getClass().getSimpleName());
      if (c instanceof SQLException se && se.getSQLState() != null) b.append(" [").append(se.getSQLState()).append("]");
      b.append(": ").append(norm(c.getMessage()));
    }
    String s = b.toString();
    return s.length() > 400 ? s.substring(0, 400) : s;
  }

  static void recordError(String op, Throwable t, double elapsedMs) {
    String state = t instanceof SQLException se && se.getSQLState() != null ? se.getSQLState() : "-";
    String msg = norm(t.getMessage()).replaceAll("S_\\d+", "S_n").replaceAll("\\d+", "N");
    if (msg.length() > 160) msg = msg.substring(0, 160);
    String key = op + "|" + t.getClass().getSimpleName() + "|" + state + "|" + msg;
    ERRORS.compute(key, (k, e) -> {
      if (e == null) {
        e = new ErrStat();
        e.example = describe(t);
        e.firstAtMs = sinceStartMs();
      }
      e.count++;
      e.minMs = Math.min(e.minMs, elapsedMs);
      e.maxMs = Math.max(e.maxMs, elapsedMs);
      return e;
    });
    FIRST_ERROR_AT.compareAndSet(-1, sinceStartMs());
  }

  // ---------- latency bookkeeping
  static final class Op {
    final AtomicLong ok = new AtomicLong();
    final AtomicLong fail = new AtomicLong();
    final List<Double> okMs = Collections.synchronizedList(new ArrayList<>());

    void good(double m) {
      ok.incrementAndGet();
      okMs.add(m);
    }
  }

  static final Map<String, Op> OPS = new LinkedHashMap<>();

  static Op op(String name) {
    synchronized (OPS) {
      return OPS.computeIfAbsent(name, k -> new Op());
    }
  }

  static double pct(List<Double> xs, double p) {
    if (xs.isEmpty()) return -1;
    List<Double> s;
    synchronized (xs) {
      s = new ArrayList<>(xs);
    }
    Collections.sort(s);
    int i = (int) Math.ceil(p / 100.0 * s.size()) - 1;
    return s.get(Math.max(0, Math.min(s.size() - 1, i)));
  }

  // ---------- connection-level bookkeeping
  /** What each worker is doing now and since when, so a stuck worker can be named at the cap. */
  static final ConcurrentHashMap<String, Object[]> CURRENT = new ConcurrentHashMap<>();

  static long mark(String op) {
    long now = System.nanoTime();
    CURRENT.put(Thread.currentThread().getName(), new Object[] {op, now});
    return now;
  }

  static final AtomicLong WRONG = new AtomicLong();
  /** The first 20 results that failed their check, verbatim enough to say what came back instead. */
  static final List<String> WRONG_EXAMPLES = Collections.synchronizedList(new ArrayList<>());

  static void wrong(String what) {
    WRONG.incrementAndGet();
    if (WRONG_EXAMPLES.size() < 20) WRONG_EXAMPLES.add(sinceStartMs() + "ms " + what);
  }

  static String rowText(ResultSet rs) throws SQLException {
    var md = rs.getMetaData();
    StringBuilder b = new StringBuilder("(");
    for (int i = 1; i <= md.getColumnCount(); i++) b.append(i > 1 ? ", " : "").append(md.getColumnName(i)).append('=').append(rs.getString(i));
    return b.append(')').toString();
  }
  static final AtomicLong SWITCHES = new AtomicLong();
  static final AtomicLong PID_SAMPLES = new AtomicLong();
  static final ConcurrentHashMap<Integer, Integer> LAST_PID = new ConcurrentHashMap<>();
  static final ConcurrentHashMap<Integer, Boolean> PIDS = new ConcurrentHashMap<>();

  static void notePid(Connection c, int pid) throws SQLException {
    int id = System.identityHashCode(c.unwrap(PGConnection.class));
    PID_SAMPLES.incrementAndGet();
    PIDS.put(pid, Boolean.TRUE);
    Integer prev = LAST_PID.put(id, pid);
    if (prev != null && prev != pid) SWITCHES.incrementAndGet();
  }

  /** Counts physical connection attempts Hikari makes, and their failures. */
  static final class CountingDS implements DataSource {
    final PGSimpleDataSource d;
    final AtomicLong attempts = new AtomicLong();
    final AtomicLong failures = new AtomicLong();
    final List<Double> connectMs = Collections.synchronizedList(new ArrayList<>());

    CountingDS(PGSimpleDataSource d) {
      this.d = d;
    }

    public Connection getConnection() throws SQLException {
      long s = System.nanoTime();
      attempts.incrementAndGet();
      try {
        Connection c = d.getConnection();
        connectMs.add(ms(System.nanoTime() - s));
        return c;
      } catch (SQLException e) {
        failures.incrementAndGet();
        recordError("connect", e, ms(System.nanoTime() - s));
        throw e;
      }
    }

    public Connection getConnection(String u, String p) throws SQLException {
      return getConnection();
    }

    public PrintWriter getLogWriter() throws SQLException {
      return d.getLogWriter();
    }

    public void setLogWriter(PrintWriter out) throws SQLException {
      d.setLogWriter(out);
    }

    public void setLoginTimeout(int seconds) throws SQLException {
      d.setLoginTimeout(seconds);
    }

    public int getLoginTimeout() throws SQLException {
      return d.getLoginTimeout();
    }

    public Logger getParentLogger() throws SQLFeatureNotSupportedException {
      return d.getParentLogger();
    }

    public <T> T unwrap(Class<T> iface) throws SQLException {
      return d.unwrap(iface);
    }

    public boolean isWrapperFor(Class<?> iface) throws SQLException {
      return d.isWrapperFor(iface);
    }
  }

  static final class Tracker implements IMetricsTracker {
    final AtomicLong created = new AtomicLong();
    final AtomicLong timeouts = new AtomicLong();

    @Override
    public void recordConnectionCreatedMillis(long ms) {
      created.incrementAndGet();
    }

    @Override
    public void recordConnectionTimeout() {
      timeouts.incrementAndGet();
    }
  }

  static final class Instance {
    final int n;
    final CountingDS cds;
    final Tracker tracker = new Tracker();
    HikariDataSource ds;
    String initError = "";
    long fillMs = -1;
    int totalAtStart = -1;

    Instance(int n, CountingDS cds) {
      this.n = n;
      this.cds = cds;
    }
  }

  static PGSimpleDataSource pg() {
    PGSimpleDataSource d = new PGSimpleDataSource();
    d.setServerNames(new String[] {env("PGHOST", "localhost")});
    d.setPortNumbers(new int[] {envInt("PGPORT", 5432)});
    d.setDatabaseName(env("PGDATABASE", "postgres"));
    d.setUser(env("PGUSER", "postgres"));
    d.setPassword(System.getenv("PGPASSWORD"));
    d.setSslMode(env("PGSSLMODE", "require"));
    d.setApplicationName("pc08-probe");
    if (!SOCKET_TIMEOUT_S.isEmpty()) d.setSocketTimeout(Integer.parseInt(SOCKET_TIMEOUT_S));
    if (!PT.isEmpty()) d.setPrepareThreshold(Integer.parseInt(PT));
    if (!QM.isEmpty()) d.setPreferQueryMode(PreferQueryMode.of(QM));
    return d;
  }

  // ---------- JSON (flat, hand-rolled: no dependency beyond the pinned jars)
  static String q(String s) {
    StringBuilder b = new StringBuilder("\"");
    for (char ch : s.toCharArray()) {
      switch (ch) {
        case '"' -> b.append("\\\"");
        case '\\' -> b.append("\\\\");
        case '\n' -> b.append("\\n");
        case '\r' -> b.append("\\r");
        case '\t' -> b.append("\\t");
        default -> {
          if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
          else b.append(ch);
        }
      }
    }
    return b.append('"').toString();
  }

  static String val(Object v) {
    if (v == null) return "null";
    if (v instanceof Number || v instanceof Boolean) return v.toString();
    if (v instanceof String s) return q(s);
    if (v instanceof Map<?, ?> m) {
      StringBuilder b = new StringBuilder("{");
      boolean first = true;
      for (Map.Entry<?, ?> e : m.entrySet()) {
        if (!first) b.append(',');
        first = false;
        b.append(q(String.valueOf(e.getKey()))).append(':').append(val(e.getValue()));
      }
      return b.append('}').toString();
    }
    if (v instanceof List<?> l) {
      StringBuilder b = new StringBuilder("[");
      for (int i = 0; i < l.size(); i++) {
        if (i > 0) b.append(',');
        b.append(val(l.get(i)));
      }
      return b.append(']').toString();
    }
    return q(v.toString());
  }

  static void emit(Map<String, Object> m) {
    System.out.println(val(m));
    System.out.flush();
  }

  /** The jar's own pom.properties: the version that actually loaded, not the one asked for. */
  static String pomVersion(Class<?> c, String resource) {
    try (var in = c.getResourceAsStream(resource)) {
      if (in == null) return "unknown";
      var p = new java.util.Properties();
      p.load(in);
      return p.getProperty("version", "unknown");
    } catch (java.io.IOException e) {
      return "unknown";
    }
  }

  static Map<String, Object> defaults() {
    Map<String, Object> m = new LinkedHashMap<>();
    PGSimpleDataSource fresh = new PGSimpleDataSource();
    m.put("pgjdbc_version", org.postgresql.util.DriverInfo.DRIVER_VERSION);
    m.put("pgjdbc_default_prepareThreshold", fresh.getPrepareThreshold());
    m.put("pgjdbc_default_preferQueryMode", fresh.getPreferQueryMode().value());
    HikariConfig c = new HikariConfig();
    m.put("hikari_version", pomVersion(HikariConfig.class, "/META-INF/maven/com.zaxxer/HikariCP/pom.properties"));
    m.put("hikari_default_maximumPoolSize", c.getMaximumPoolSize());
    m.put("hikari_default_minimumIdle", c.getMinimumIdle());
    m.put("hikari_default_connectionTimeout_ms", c.getConnectionTimeout());
    m.put("hikari_default_validationTimeout_ms", c.getValidationTimeout());
    m.put("hikari_default_idleTimeout_ms", c.getIdleTimeout());
    m.put("hikari_default_maxLifetime_ms", c.getMaxLifetime());
    m.put("hikari_default_keepaliveTime_ms", c.getKeepaliveTime());
    m.put("hikari_default_initializationFailTimeout_ms", c.getInitializationFailTimeout());
    m.put("java_version", System.getProperty("java.version"));
    return m;
  }

  // ---------- workload
  static void workloadWorker(Instance in, int w) {
    ThreadLocalRandom r = ThreadLocalRandom.current();
    Op sel = op("select"), upd = op("update_txn"), ins = op("insert_batch_txn"), it = op("iteration");
    for (int i = 0; i < ITER; i++) {
      if (sinceStartMs() > MAX_WALL_MS) return;
      long t0 = System.nanoTime();
      boolean all = true;
      long id = 1 + r.nextInt(ITEMS);
      long s = mark("select");
      try (Connection c = in.ds.getConnection(); PreparedStatement ps = c.prepareStatement(SEL)) {
        ps.setLong(1, id);
        try (ResultSet rs = ps.executeQuery()) {
          if (!rs.next()) wrong("select id " + id + ": no row");
          else if (rs.getMetaData().getColumnCount() != 5 || rs.getLong(1) != id || !"sel".equals(rs.getString(4))) wrong("select id " + id + ": got " + rowText(rs));
          else notePid(c, rs.getInt(5));
        }
        sel.good(ms(System.nanoTime() - s));
      } catch (SQLException e) {
        all = false;
        sel.fail.incrementAndGet();
        recordError("select", e, ms(System.nanoTime() - s));
      }
      s = mark("update_txn");
      try (Connection c = in.ds.getConnection()) {
        c.setAutoCommit(false);
        try (PreparedStatement ps = c.prepareStatement(UPD)) {
          ps.setString(1, "i" + in.n + "w" + w + "n" + i);
          ps.setLong(2, id);
          try (ResultSet rs = ps.executeQuery()) {
            if (!rs.next()) wrong("update id " + id + ": no row");
            else if (rs.getMetaData().getColumnCount() != 2 || rs.getLong(1) != id || !"upd".equals(rs.getString(2))) wrong("update id " + id + ": got " + rowText(rs));
          }
          c.commit();
        } catch (SQLException e) {
          try {
            c.rollback();
          } catch (SQLException ignore) {
            // the connection may already be gone; the first error is the one recorded
          }
          throw e;
        }
        upd.good(ms(System.nanoTime() - s));
      } catch (SQLException e) {
        all = false;
        upd.fail.incrementAndGet();
        recordError("update_txn", e, ms(System.nanoTime() - s));
      }
      s = mark("insert_batch_txn");
      try (Connection c = in.ds.getConnection()) {
        c.setAutoCommit(false);
        try (PreparedStatement ps = c.prepareStatement(INS)) {
          for (int k = 0; k < 5; k++) {
            ps.setLong(1, 1 + r.nextInt(ITEMS));
            ps.setString(2, "i" + in.n + "w" + w + "n" + i + "r" + k);
            ps.addBatch();
          }
          int[] counts = ps.executeBatch();
          int sum = 0;
          for (int x : counts) sum += (x == Statement.SUCCESS_NO_INFO ? 1 : x);
          if (counts.length != 5 || sum != 5) wrong("insert batch: counts " + java.util.Arrays.toString(counts));
          c.commit();
        } catch (SQLException e) {
          try {
            c.rollback();
          } catch (SQLException ignore) {
            // as above
          }
          throw e;
        }
        ins.good(ms(System.nanoTime() - s));
      } catch (SQLException e) {
        all = false;
        ins.fail.incrementAndGet();
        recordError("insert_batch_txn", e, ms(System.nanoTime() - s));
      }
      if (all) it.good(ms(System.nanoTime() - t0));
      else it.fail.incrementAndGet();
    }
  }

  static void holdWorker(Instance in, int w) {
    Op borrow = op("hold_borrow"), exec = op("hold_exec"), fu = op("followup");
    for (int i = 0; i < HOLD_REPEAT; i++) {
      if (sinceStartMs() > MAX_WALL_MS) return;
      long s = mark("hold");
      Connection c = null;
      try {
        c = in.ds.getConnection();
        borrow.good(ms(System.nanoTime() - s));
        long e0 = System.nanoTime();
        try (Statement st = c.createStatement()) {
          st.execute(HOLD_SQL);
          exec.good(ms(System.nanoTime() - e0));
        } catch (SQLException e) {
          exec.fail.incrementAndGet();
          recordError("hold_exec", e, ms(System.nanoTime() - e0));
        }
      } catch (SQLException e) {
        borrow.fail.incrementAndGet();
        recordError("hold_borrow", e, ms(System.nanoTime() - s));
      } finally {
        if (c != null) {
          try {
            c.close();
          } catch (SQLException ignore) {
            // returned to the pool either way
          }
        }
      }
    }
    long s = mark("followup");
    try (Connection c = in.ds.getConnection(); Statement st = c.createStatement()) {
      st.execute("select 1");
      fu.good(ms(System.nanoTime() - s));
    } catch (SQLException e) {
      fu.fail.incrementAndGet();
      recordError("followup", e, ms(System.nanoTime() - s));
    }
  }

  static final java.util.concurrent.atomic.AtomicBoolean SUMMARISED = new java.util.concurrent.atomic.AtomicBoolean();

  static void summary(List<Thread> threads, List<Instance> instances, Map<String, Object> cfg, boolean capHit, boolean bySignal) {
    if (!SUMMARISED.compareAndSet(false, true)) return;
    long wallMs = sinceStartMs();

    Map<String, Object> sum = new LinkedHashMap<>();
    sum.put("e", "summary");
    sum.put("mode", MODE);
    sum.put("wall_ms", wallMs);
    sum.put("wall_cap_hit", capHit || wallMs > MAX_WALL_MS);
    sum.put("terminated_by_signal", bySignal);
    List<Map<String, Object>> stuck = new ArrayList<>();
    for (Thread t : threads) {
      Object[] cur = CURRENT.get(t.getName());
      if (!t.isAlive() || cur == null) continue;
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("thread", t.getName());
      m.put("op", cur[0]);
      m.put("in_op_ms", (System.nanoTime() - (Long) cur[1]) / 1_000_000);
      stuck.add(m);
    }
    sum.put("threads_alive_at_end", stuck.size());
    sum.put("threads_alive", stuck);
    sum.put("threads", threads.size());
    sum.put("first_error_ms", FIRST_ERROR_AT.get());
    sum.put("wrong_results", WRONG.get());
    sum.put("wrong_examples", new ArrayList<>(WRONG_EXAMPLES));
    sum.put("backend_pid_samples", PID_SAMPLES.get());
    sum.put("backend_switches", SWITCHES.get());
    sum.put("distinct_backend_pids", PIDS.size());
    sum.put("physical_connections_seen", LAST_PID.size());
    Map<String, Object> ops = new LinkedHashMap<>();
    synchronized (OPS) {
      for (Map.Entry<String, Op> e : OPS.entrySet()) {
        Op o = e.getValue();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", o.ok.get());
        m.put("fail", o.fail.get());
        m.put("p50_ms", pct(o.okMs, 50));
        m.put("p95_ms", pct(o.okMs, 95));
        m.put("p99_ms", pct(o.okMs, 99));
        m.put("max_ms", pct(o.okMs, 100));
        ops.put(e.getKey(), m);
      }
    }
    sum.put("ops", ops);
    Op it = OPS.get("iteration");
    sum.put("throughput_iter_per_s", it == null || wallMs == 0 ? 0 : Math.round(it.ok.get() * 100000.0 / wallMs) / 100.0);
    List<Map<String, Object>> errs = new ArrayList<>();
    ERRORS.entrySet().stream()
        .sorted((a, b) -> Long.compare(b.getValue().count, a.getValue().count))
        .limit(15)
        .forEach(e -> {
          Map<String, Object> m = new LinkedHashMap<>();
          String[] parts = e.getKey().split("\\|", 4);
          m.put("op", parts[0]);
          m.put("class", parts[1]);
          m.put("sqlstate", parts[2]);
          m.put("count", e.getValue().count);
          m.put("first_at_ms", e.getValue().firstAtMs);
          m.put("elapsed_min_ms", e.getValue().minMs);
          m.put("elapsed_max_ms", e.getValue().maxMs);
          m.put("example", e.getValue().example);
          errs.add(m);
        });
    sum.put("error_kinds", ERRORS.size());
    sum.put("errors", errs);
    List<Map<String, Object>> pools = new ArrayList<>();
    for (Instance in : instances) {
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("instance", in.n);
      m.put("init_error", in.initError);
      m.put("fill_ms", in.fillMs);
      m.put("total_at_start", in.totalAtStart);
      m.put("connect_attempts", in.cds.attempts.get());
      m.put("connect_failures", in.cds.failures.get());
      m.put("connect_p50_ms", pct(in.cds.connectMs, 50));
      m.put("connect_max_ms", pct(in.cds.connectMs, 100));
      m.put("hikari_created", in.tracker.created.get());
      m.put("hikari_timeouts", in.tracker.timeouts.get());
      if (in.ds != null) {
        m.put("total_end", in.ds.getHikariPoolMXBean().getTotalConnections());
        m.put("active_end", in.ds.getHikariPoolMXBean().getActiveConnections());
        m.put("waiting_end", in.ds.getHikariPoolMXBean().getThreadsAwaitingConnection());
      }
      pools.add(m);
    }
    sum.put("pools", pools);
    sum.put("config", cfg);
    emit(sum);
  }

  public static void main(String[] args) throws Exception {
    Map<String, Object> cfg = new LinkedHashMap<>();
    cfg.put("e", "config");
    cfg.put("mode", MODE);
    cfg.putAll(defaults());
    if (MODE.equals("defaults")) {
      emit(cfg);
      return;
    }
    if (MODE.equals("ping")) {
      long s = System.nanoTime();
      try (Connection c = pg().getConnection(); Statement st = c.createStatement(); ResultSet rs = st.executeQuery("select 1, current_setting('server_version')")) {
        rs.next();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("e", "ping");
        m.put("ok", true);
        m.put("ms", ms(System.nanoTime() - s));
        m.put("server_version", rs.getString(2));
        emit(m);
        return;
      } catch (SQLException e) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("e", "ping");
        m.put("ok", false);
        m.put("ms", ms(System.nanoTime() - s));
        m.put("error", describe(e));
        emit(m);
        System.exit(3);
      }
    }

    PGSimpleDataSource probeDs = pg();
    cfg.put("prepareThreshold_effective", probeDs.getPrepareThreshold());
    cfg.put("preferQueryMode_effective", probeDs.getPreferQueryMode().value());
    cfg.put("socketTimeout_s_effective", probeDs.getSocketTimeout());
    cfg.put("instances", INSTANCES);
    cfg.put("pool_size", POOL);
    cfg.put("workers_per_instance", WORKERS);
    cfg.put("iterations", MODE.equals("hold") ? HOLD_REPEAT : ITER);
    if (MODE.equals("hold")) cfg.put("hold_sql", HOLD_SQL);
    emit(cfg);

    List<Instance> instances = new ArrayList<>();
    for (int n = 0; n < INSTANCES; n++) {
      Instance in = new Instance(n, new CountingDS(pg()));
      HikariConfig hc = new HikariConfig();
      hc.setPoolName("app" + n);
      hc.setDataSource(in.cds);
      hc.setMaximumPoolSize(POOL);
      if (!CONN_TIMEOUT.isEmpty()) hc.setConnectionTimeout(Long.parseLong(CONN_TIMEOUT));
      hc.setMetricsTrackerFactory((poolName, stats) -> in.tracker);
      try {
        in.ds = new HikariDataSource(hc);
      } catch (RuntimeException e) {
        in.initError = describe(e);
        recordError("pool_init", e, 0);
      }
      instances.add(in);
    }
    if (!instances.isEmpty() && instances.get(0).ds != null) {
      Map<String, Object> hcfg = new LinkedHashMap<>();
      HikariDataSource d0 = instances.get(0).ds;
      hcfg.put("maximumPoolSize", d0.getMaximumPoolSize());
      hcfg.put("minimumIdle", d0.getMinimumIdle());
      hcfg.put("connectionTimeout_ms", d0.getConnectionTimeout());
      hcfg.put("validationTimeout_ms", d0.getValidationTimeout());
      hcfg.put("maxLifetime_ms", d0.getMaxLifetime());
      hcfg.put("keepaliveTime_ms", d0.getKeepaliveTime());
      cfg.put("hikari_effective", hcfg);
    }
    // Let each pool fill (minimumIdle = maximumPoolSize by default) before the clock starts.
    long fill0 = System.nanoTime();
    for (Instance in : instances) {
      if (in.ds == null) continue;
      while (in.ds.getHikariPoolMXBean().getTotalConnections() < POOL && (System.nanoTime() - fill0) / 1_000_000 < FILL_WAIT_MS) Thread.sleep(50);
      in.fillMs = (System.nanoTime() - fill0) / 1_000_000;
      in.totalAtStart = in.ds.getHikariPoolMXBean().getTotalConnections();
    }

    List<Thread> threads = new ArrayList<>();
    CountDownLatch go = new CountDownLatch(1);
    for (Instance in : instances) {
      for (int w = 0; w < WORKERS; w++) {
        final int ww = w;
        Thread t = new Thread(() -> {
          try {
            go.await();
          } catch (InterruptedException e) {
            return;
          }
          if (in.ds == null) {
            if (MODE.equals("hold")) op("hold_borrow").fail.incrementAndGet();
            else op("iteration").fail.addAndGet(ITER);
            return;
          }
          if (MODE.equals("hold")) holdWorker(in, ww);
          else workloadWorker(in, ww);
          CURRENT.remove(Thread.currentThread().getName());
        }, "w" + in.n + "-" + w);
        t.setDaemon(true);
        threads.add(t);
        t.start();
      }
    }
    // `docker stop` (SIGTERM) still gets a summary, marked as such.
    Runtime.getRuntime().addShutdownHook(new Thread(() -> summary(threads, instances, cfg, true, true)));
    workStart = System.nanoTime();
    Map<String, Object> st = new LinkedHashMap<>();
    st.put("e", "start");
    st.put("threads", threads.size());
    emit(st);
    go.countDown();
    boolean capHit = false;
    for (Thread t : threads) {
      long left = MAX_WALL_MS + 5000 - sinceStartMs();
      if (left <= 0) {
        capHit = true;
        break;
      }
      t.join(left);
      if (t.isAlive()) capHit = true;
    }
    summary(threads, instances, cfg, capHit, false);
    // Daemon workers stuck past the cap must not keep the JVM up; pools are not closed gracefully on purpose
    // (a close would block on a stuck connection).
    System.out.flush();
    Runtime.getRuntime().halt(0);
  }
}
