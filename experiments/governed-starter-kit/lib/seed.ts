/**
 * The kit's seed data, shared by scripts/kit.ts (hosted projects, through the
 * Management API) and scripts/agent-local.ts (a local stack, through psql),
 * so both seed the same departments, users, requests and knowledge-base rows.
 *
 * Users are created by the caller through the Auth admin API with
 * app_metadata { department, role }; the trigger in sql/00-baseline.sql
 * turns that into a profile.
 */

export const DEPARTMENTS = ["Sales", "Marketing"];

export const USERS = [
  { email: "alice@example.com", name: "Alice", department: "Sales", role: "employee" },
  { email: "bob@example.com", name: "Bob", department: "Sales", role: "manager" },
  { email: "carol@example.com", name: "Carol", department: "Marketing", role: "employee" },
  { email: "dave@example.com", name: "Dave", department: "Marketing", role: "manager" },
];

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** A generated password in the shape the hosted Auth password policy accepts. */
export const newPassword = () => `${crypto.randomUUID()}Aa1!`;

export const DEPARTMENTS_SQL = `insert into public.departments (name) values ${DEPARTMENTS.map((d) => `(${lit(d)})`).join(", ")}
     on conflict (name) do nothing`;

// Example rows, inserted as postgres (the table owner) with explicit ids.
export const REQUESTS_SQL = `insert into public.purchase_requests (department_id, requester_id, item, vendor, amount, justification)
     select p.department_id, p.id, v.item, v.vendor, v.amount, v.why
       from public.profiles p
       join auth.users u on u.id = p.id
       join (values
         ('alice@example.com', 'Conference booth kit', 'Acme Displays', 1800.00, 'Trade show next quarter'),
         ('alice@example.com', 'CRM seat add-on', 'Acme Software', 240.00, 'New hire'),
         ('carol@example.com', 'Stock photo licence', 'Acme Media', 420.00, 'Campaign assets')
       ) as v(email, item, vendor, amount, why) on v.email = u.email
      where not exists (select 1 from public.purchase_requests)`;

// Knowledge-base rows with placeholder embeddings: enough for the RLS
// checks. `kit.ts embed` (or agent-local) replaces them with real gte-small
// vectors from the agent Edge Function. Idempotent per title, so re-seeding
// an existing project adds new rows without duplicating old ones. Counts the
// K01 positive controls rely on: 4 company-wide, 2 Sales, 2 Marketing.
export const KB_SQL = `insert into public.kb_chunks (department_id, title, content, embedding)
     select d.id, v.title, v.content,
            (select array_agg(random()::real) from generate_series(1, 384))::extensions.vector
       from (values
         (null, 'Purchasing limits', 'Requests above 2,000 need a second approver.'),
         (null, 'Approval routing', 'Purchase requests are approved or rejected by a manager in the requester''s own department. Nobody can approve their own request, and an approved request cannot be reopened.'),
         (null, 'New vendors', 'Buying from a vendor for the first time needs a completed vendor form and, for software or anything above 5,000, a security review before the request is approved.'),
         (null, 'Software subscriptions', 'Prefer annual billing for subscriptions the team will keep longer than a year. Seat add-ons go through the same request flow as new tools.'),
         ('Sales', 'Sales events budget', 'Trade show spend is capped per quarter.'),
         ('Sales', 'Sales client entertainment', 'Client meals and events are capped per head per event; attach receipts and the client account name in the justification.'),
         ('Marketing', 'Marketing licences', 'Stock media must use the approved vendors.'),
         ('Marketing', 'Marketing agency retainers', 'Agency retainers are reviewed every quarter; a new retainer needs a scope document attached to the request.')
       ) as v(dept, title, content)
       left join public.departments d on d.name = v.dept
      where not exists (select 1 from public.kb_chunks k where k.title = v.title)`;

/** Text that gets embedded for a kb_chunks row (title and content). */
export const kbText = (title: string, content: string) => `${title}. ${content}`;
