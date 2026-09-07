# Linear to Plane migration

2026-09-07: copy only the three unfinished Manual Acceptance items from the 47-item source project. No product implementation or manual acceptance is performed by this migration. Repository, default branch, product/privacy boundaries and root AGENTS.md's sole workflow authority are unchanged.

| Linear alias | Linear UUID | Original createdAt | Plane item | Plane UUID |
|---|---|---|---|---|
| BUI-212 | 1fc3bd65-1629-4fca-90b1-74327008ddd5 | 2026-08-23T13:59:51.427Z | [CAP-1](https://app.plane.so/team-nc/browse/CAP-1/) | 92ec5d53-58a1-4e39-81ef-61edee733106 |
| BUI-233 | b4c14b8d-4704-4bcb-9acc-d14f8eb0f64c | 2026-08-25T11:24:33.403Z | [CAP-2](https://app.plane.so/team-nc/browse/CAP-2/) | 0ae6eb9c-90e4-413d-8499-c09c8cc9ee37 |
| BUI-234 | b45f41d7-f11f-4ce6-8427-76d9e5f25e09 | 2026-08-25T11:25:02.304Z | [CAP-3](https://app.plane.so/team-nc/browse/CAP-3/) | ab309592-a301-4a57-87c2-2cc83f59af56 |

## Plane migration compatibility

Workspace `team-nc` (`f223b880-1f10-40f1-b22c-9070248fd0e1`), project `Caprine AI Assist` / `CAP` (`e939c63a-ad50-4756-80b9-8c83aec0d950`). Root `AGENTS.md` remains the sole executable workflow; `PLANE_MIGRATION.md` provides historical aliases and source constraints. Resolve actual tool schemas, state UUIDs and full pagination. Exclude archived/synthetic items and terminal work. Native `blocked_by` / `blocking` is the work-order graph; module order and parent-child relations are not blockers. Unknown dependencies and failed lookups are not evidence of completion. Only verified Done prerequisites may be treated as completed.

Order equal-level eligible work by urgent, high, medium, low, none; original createdAt then numeric BUI alias for migrated work, otherwise Plane created_at then numeric CAP identifier. Resume existing PR/branch/worktree lineage before new selection. Resolve old BUI links through the map rather than starting duplicate work. Historical Linear project `e4c3c746-951b-41bb-b918-be89645f15f9` is read-only after cutover.

CAP-1 / BUI-212, CAP-2 / BUI-233 and CAP-3 / BUI-234 are all Manual Acceptance; preserve every source requirement and skip autonomous implementation absent owner participation or supplied evidence. CAP-1 is natively blocked by CAP-2 and CAP-3. Tests, fixtures, source inspection and packaging do not prove real Messenger, Mac, mobile-client or credential-dependent acceptance.

Explicitly link the GitHub PR on Plane and the Plane item in the PR. Do not assume Closes CAP-### updates Plane automatically. Verify merge reachability on remote main before explicitly marking Plane Done; reconcile only stale metadata when already merged. QA-only schedules retain their narrower original write scope and never implement, merge or change issue status. Deduplicate fresh QA evidence against mapped active work and historical Linear evidence; any newly confirmed recurrence is tracked in Plane, never by reopening historical Linear.

## Preserved dependencies and documents

CAP-1 is blocked by CAP-2 and CAP-3 using native Plane dependencies. Other prerequisites were freshly verified Done: BUI-262, BUI-261, BUI-211, BUI-266, BUI-264, BUI-224, BUI-230, BUI-270, BUI-232, BUI-202 and BUI-231. Source URLs and completedAt remain in target descriptions. No completed issue was recreated as unfinished work. M2, M3 and M7 modules preserve the outstanding planning groups; module ordering is not a blocker.

All three full source descriptions, original priorities, labels, assignee, creation ordering and source links are retained. Source comments were empty after complete reads. Attachment URLs remain source links, not offline backups.

Private Plane Pages:

- [MVP product contract](https://app.plane.so/team-nc/projects/e939c63a-ad50-4756-80b9-8c83aec0d950/pages/97700851-d8c2-4c9c-83b9-020b9714397f/): original content retained; current root AGENTS and authorized issue refinements retain their authority.
- [Active worker](https://app.plane.so/team-nc/projects/e939c63a-ad50-4756-80b9-8c83aec0d950/pages/c4d98ccd-280f-4fbf-ad34-cafada94bf94/): tracker routing changed, existing root workflow retained.
- [Issue template](https://app.plane.so/team-nc/projects/e939c63a-ad50-4756-80b9-8c83aec0d950/pages/722da662-5469-49f9-8d5a-cb0f4a523c1e/): lightweight authoring aid, not an approval gate.

## Cutover and recovery

Preserve the existing Discovery review, adjudicated frozen Closure Set when necessary, bounded Closure review and at most one targeted repair/verifier. Do not introduce another review or approval regime.

After source/target readback, checks, required review and verified migration merge, update and read back the actual worker and daily QA prompts. Preserve schedule names, model, reasoning, frequency, working directory, execution mode and notifications. The worker was PAUSED and stays PAUSED; resume only the previously ACTIVE daily QA. Historical daily-at-11 document text does not change the actual hourly worker schedule.

Do not run old and new tracker writers together. If a required cutover check fails, preserve all source and target records, keep the affected writer paused, and reconcile the concrete mismatch. A Plane outage does not authorize writes to historical Linear. No new scheduler, issue-sync service, migration framework, or product backlog is created. Source and scheduler snapshots remain outside Git.
