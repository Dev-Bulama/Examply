# Roadmap

The original 10 phases from `PROMPT.md`, extended with three product requests made during the build:

1. **AI generation** — the admin adds a Claude or OpenAI key; a prompt generates certification-level questions and exams that candidates take and earn certificates from.
2. **Cyber security terminal labs** — candidates complete hands-on tasks in a real-time terminal and answer questions inside the lab.
3. **Company subscriptions** — IT companies subscribe to a plan and get their own workspace to build questions and exams (with AI) for their users.

| Phase | Scope | Status |
|---|---|---|
| 1. Foundation | Config, migrations, security, installer, auth, 2FA, RBAC, admin and candidate shells | ✅ |
| 2. Catalogue & question bank | Categories, certifications, domains, programmes; 11 question types; versioning; review workflow | ✅ |
| 3. Import / export **+ AI generation** | 7 import formats with dry run, undo and error report; export; **Claude / OpenAI generation into the same preview**; marketing landing page; plan records | ✅ |
| 4. Exam builder + instruction generator | Every §3.5 setting, blueprints, sections, bands, pre-publish checklist. **SQL lab question type.** **AI: "generate a complete exam"**. (Public catalogue pages move to Phase 5, with the candidate flow.) | ✅ |
| 5. Exam engine, grading, results, certificates | Public catalogue pages, candidate flow, server timer, autosave/offline, proctoring, the §4 grading engine, results, PDF slip, certificates and `/verify`. AI-generated exams issue certificates through the same flow; SQL lab answers graded by result-set comparison | ✅ |
| **5A. Cyber security labs** | Lab engine, lab question type, exam integration (details below) | |
| 6. Commerce | Products, packs, bundles, coupons, Paystack and **bank transfer**, entitlements, invoices, **plan subscriptions for companies** (Paystack Plans) | Next |
| 7. Organisations → **company workspaces** | Tenant-scoped bank, exams, labs and AI quota (`organisation_id` columns already exist); workspace admin portal; seats, cohorts, bulk invite, learning-gain reports; plan limits enforced | |
| 8. Live quiz | Socket.IO sessions, PIN join, leaderboards, homework mode | |
| 9. Analytics, notifications, CMS, support | Item analysis, KR-20, dashboards, email templates, announcements, homepage CMS, tickets | |
| 10. Hardening & delivery | Full test pass, accessibility, performance, security review, 60+ seed questions, documentation | |

## 5A — Cyber security labs (design)

**Constraint:** Hostinger shared/Node hosting cannot run Docker, VMs or per-candidate Linux users. Giving candidates a real shell on the web server would also be a serious security risk.

**Design:** a server-authoritative simulated Linux environment.

- **Engine** (pure JavaScript, no native modules):
  - a per-attempt virtual filesystem (paths, contents, owners, permission bits);
  - users and groups, processes, services, listening ports, firewall rules, cron jobs;
  - log files, plus simulated network hosts that tools like `nmap`, `ssh` and `curl` can reach.
- **Commands:** about 60 common commands (`ls`, `cat`, `grep`, `awk`, `sed -i`, `find`, `chmod`, `chown`, `ps`, `kill`, `ss`/`netstat`, `ufw`/`iptables`, `systemctl`, `journalctl`, `last`, `useradd`/`userdel`, `passwd -l`, `crontab`, `sha256sum`, `base64`, `nmap`, …). Pipes, redirection, `sudo` and environment variables are supported. Unknown commands give realistic errors.
- **Terminal:** xterm.js in the browser, connected to the engine over Socket.IO (long-polling fallback). Every keystroke is processed server-side, so the browser holds no answers and state cannot be tampered with.
- **Scenario authoring:**
  - JSON or YAML scenarios define the starting machine(s) and the tasks;
  - checks are declarative (`file_contains`, `file_mode`, `user_absent`, `service_state`, `port_closed`, `firewall_denies`, `command_ran`, `flag_submitted`);
  - the AI generator can draft scenarios for review.
- **In exams:** a `lab` question type. Each task is marked automatically with partial credit, and candidates can also answer questions inside the lab (`submit <flag>`). The lab timer, the transcript and an integrity log feed the normal results and certificate flow.
- **Upgrade path:** a `LabRunner` interface. The simulated runner is the default; an optional external runner (Docker or Firecracker on a separate VPS, reached over an authenticated WebSocket) can be plugged in later for full real-machine labs, without changing scenarios or grading.

## Company workspaces (design)

- `organisations` becomes the tenant. `organisation_id` already exists on questions, categories, imports, exams and AI generations; when it is NULL, the content is platform-owned.
- Plans are `products` with `type = 'plan'`, `audience = 'organisation'`, a feature list and enforceable `limits`. These fields exist now and the landing page renders them. The limits are: candidates, AI questions per month, staff seats, labs, custom branding.
- A workspace admin portal reuses the admin screens, filtered to the workspace. Workspace staff roles are granted per organisation, and every query is scoped by `organisation_id` (tested like the RBAC route walk).
- AI usage is metered per workspace from `ai_generations` token and question counts, against the plan's monthly quota.
