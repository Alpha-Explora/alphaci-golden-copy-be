# kernel

Cross-cutting infrastructure with no feature owner. Every module may import
from here; **this directory may never import from `src/modules/`.**

| Folder    | Holds                                                        |
|-----------|--------------------------------------------------------------|
| `db/`     | `database.service`, `postgres-ssl.config`, Supabase client (`db/supabase/`) |
| `events/` | `outbox.repository` — the only genuinely shared repository    |
| `auth/`   | session-user lookup contract                                  |

`config/` (app config, env validation) and `http/` (guards, filters,
correlation middleware) remain in the historical `src/common/` and `src/config/`
paths until a
second module needs them — see the admission rule below.

## Admission rule

Something belongs here only when a **second** module needs it. One consumer
means it lives inside that module. This rule is what stops `kernel/` becoming
the next `persistence/`.

Migration status: db + events + auth contract landed; the rest of the old plan
lives in `docs/architecture/FUTURE_STATE.md`.
