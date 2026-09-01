# Technical kernel

`src/kernel/` contains cross-cutting technical infrastructure with no business
context owner. Bounded contexts may depend on the kernel; **kernel code must
never import from `src/modules/`.**

| Folder | Responsibility |
|---|---|
| `auth/` | session lookup contracts and application-wide authentication guards |
| `config/` | environment validation and application/security configuration |
| `db/` | database services, PostgreSQL configuration, and Supabase access |
| `events/` | outbox persistence, topic registration, and event dispatching |
| `http/` | exception filters and HTTP middleware shared by the application |
| `ports/` | small dependency-inversion ports used to break genuine context cycles |

## Admission rule

Add a capability to the kernel only when it is technical infrastructure needed
by at least two bounded contexts. A capability used by one context belongs in
that context. This rule prevents the kernel from becoming an unowned business
module or a second persistence layer.
