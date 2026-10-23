# jq -f peak.jq result.json  (one DBArena result.json; prints the peak-concurrency cell)
def med3: sort | .[(length/2|floor)];
[.sweep[] | {c:.concurrency, w:.workload_parameters.warehouses,
  tpms:[.iterations[]|.workload_metrics.transactions.NEW_ORDER.tpm],
  rtts:[.iterations[]|.metadata.network_rtt.median_us],
  p95s:[.iterations[]|.workload_metrics.transactions.NEW_ORDER.latency_ms.p95],
  sel:([.iterations[]|select(.median)][0])}
 | .m = (.tpms|med3)] | max_by(.m)
 | {c, w, tpm:.sel.workload_metrics.transactions.NEW_ORDER.tpm, p95:.sel.workload_metrics.transactions.NEW_ORDER.latency_ms.p95, rtt_sel:.sel.metadata.network_rtt.median_us, tpms, rtts}
