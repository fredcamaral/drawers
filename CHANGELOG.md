# [1.5.0](https://github.com/fredcamaral/opencode-drawers/compare/v1.4.1...v1.5.0) (2026-06-11)


### Features

* **statusline:** add opencode-drawer-statusline plugin ([963fe82](https://github.com/fredcamaral/opencode-drawers/commit/963fe826fc78c074d2009877dfb3a7c107f9f723))
* **workflows:** add shell() primitive to runtime API ([71cb36b](https://github.com/fredcamaral/opencode-drawers/commit/71cb36bb55f39e3d20ce4648fe9620cc7eca7d4b))

## [1.4.1](https://github.com/fredcamaral/opencode-drawers/compare/v1.4.0...v1.4.1) (2026-06-11)


### Bug Fixes

* **core:** make SDK errors throw, harden the task lifecycle, and type the shared seam ([1bfd4c0](https://github.com/fredcamaral/opencode-drawers/commit/1bfd4c0784b20caa1903e383dca7e9bff13e3900))

# [1.4.0](https://github.com/fredcamaral/opencode-drawers/compare/v1.3.0...v1.4.0) (2026-06-11)


### Bug Fixes

* **background-agents:** coalesce undefined transcript part text in bg_output ([8ade99f](https://github.com/fredcamaral/opencode-drawers/commit/8ade99f2e38b7ec940fdcdc41372171045a551c9))
* **background-agents:** point smoke harness at the engine's tasks store leaf ([2d08778](https://github.com/fredcamaral/opencode-drawers/commit/2d087786b9ee084a4b44aea00525ec14efa60e23))
* **background-agents:** surface failed parent-transcript fetch instead of forking blind ([55bd6b0](https://github.com/fredcamaral/opencode-drawers/commit/55bd6b0a9cced6b898ca14c4069c0426686c1a25))
* **cadence:** require an arming baseline and honor dispose mid-await ([670516c](https://github.com/fredcamaral/opencode-drawers/commit/670516cbfe795677bca05221443dbd248e047905))
* **cadence:** validate numeric fields in load() so the iteration cap holds ([1726c4f](https://github.com/fredcamaral/opencode-drawers/commit/1726c4f65925bb8d6e82bebca7445673df7bd3e4))
* **cadence:** wire the SDK client through core's adaptSdkClient ([43797f0](https://github.com/fredcamaral/opencode-drawers/commit/43797f0235794f26ca1300b21e576e0a5e839754))
* **core:** release the slot when cancel races an immediate acquire ([9fe2cc1](https://github.com/fredcamaral/opencode-drawers/commit/9fe2cc1587630680ab9b2c3ee1d21d0182ff3ecf))
* **core:** tear down the slot on promote-to-running persist failure; distinguish queue-timeout cancels ([98e77f3](https://github.com/fredcamaral/opencode-drawers/commit/98e77f32a7b661e6b7ddb91feee712db9b3081f4))
* **workflows:** drop cosmetic label/phase from agent cache key ([fa466c9](https://github.com/fredcamaral/opencode-drawers/commit/fa466c98d00e7ff3fbbfcd46cafdd73bfe6c1fdf))
* **workflows:** guard TUI token math against partial feed tokens ([876d355](https://github.com/fredcamaral/opencode-drawers/commit/876d35560d0f4e796166006bf87542a047de0520))
* **workflows:** harden git-truth seam, rolling-wave gates, and skills injection ([9ef6fb1](https://github.com/fredcamaral/opencode-drawers/commit/9ef6fb1be06f51b3e61ea45ee0b8f111ec7b0ff6))


### Features

* **cadence:** add the loop and goal orchestration plugin ([ca326d0](https://github.com/fredcamaral/opencode-drawers/commit/ca326d0c6b8ffad7a588def6ff7b816a86a866eb))
* **core:** add optional stat/lstat/realpath to FsFacade ([5f5f8bb](https://github.com/fredcamaral/opencode-drawers/commit/5f5f8bb1f45e37c7b55b8d17d7d75c747d3994c3))
* **workflows:** add skills injection, run digest, and TUI details ([0faa7f5](https://github.com/fredcamaral/opencode-drawers/commit/0faa7f549b8bec7d163d8a71ac0ad19f874fe90d))
* **workflows:** ground engine results in git truth and isolate verified agents ([5d95229](https://github.com/fredcamaral/opencode-drawers/commit/5d95229699b770537d1f45c087b595d751c5fb51))
* **workflows:** name the six patterns, ship deep-research, save runs as commands ([24d6052](https://github.com/fredcamaral/opencode-drawers/commit/24d6052f1e654137f480839c55b1c08e025f8dc6))
* **workflows:** teach LLM-authored scripts to use the git-truth review API ([c3214ec](https://github.com/fredcamaral/opencode-drawers/commit/c3214ec12ade8ca19ddfbd5434036954de8839a3))


### Performance Improvements

* **core:** index tasks by session id for O(1) gate lookup ([5b12dd0](https://github.com/fredcamaral/opencode-drawers/commit/5b12dd0a8d6047f295a8b4d7055c038fcd32b674)), closes [hi#frequency](https://github.com/hi/issues/frequency)
* **core:** prune notify dedup keys on flush ([46d30ce](https://github.com/fredcamaral/opencode-drawers/commit/46d30cecf87ed6d25533f8eab9b396f51ab19df3))
* **workflows:** index live runs by parentSessionID for the digest hot path ([de50f10](https://github.com/fredcamaral/opencode-drawers/commit/de50f10017173a96276b95f42773ca9ff3cc9463))

# [1.3.0](https://github.com/fredcamaral/opencode-drawers/compare/v1.2.0...v1.3.0) (2026-06-09)


### Features

* **workflows:** per-agent git worktree isolation with TUI-safe engine shell ([c8034a4](https://github.com/fredcamaral/opencode-drawers/commit/c8034a4fd2d8199a82db2bfeebc4ab7a6348345c))

# [1.2.0](https://github.com/fredcamaral/opencode-drawers/compare/v1.1.0...v1.2.0) (2026-06-09)


### Features

* **core:** add per-launch directory query for worktree isolation ([b536347](https://github.com/fredcamaral/opencode-drawers/commit/b5363476c551394e6ce63837b737437cfe2b60d0))
* **workflows:** harden workflow runtime with git checkpointing, deny hooks, and TUI improvements ([f976661](https://github.com/fredcamaral/opencode-drawers/commit/f9766613d8514e7a448b948dd23340866b2365a3))

# [1.1.0](https://github.com/fredcamaral/opencode-drawers/compare/v1.0.0...v1.1.0) (2026-06-08)


### Bug Fixes

* **build:** compile the TUI bundle with @opentui/solid's Solid transform ([4a97b59](https://github.com/fredcamaral/opencode-drawers/commit/4a97b59c07cf811ce9a6620f374d745b693f8b16))
* **workflows:** drop the per-agent wall-clock timeout ([922284d](https://github.com/fredcamaral/opencode-drawers/commit/922284dd9e7a9cd821be704320c9803ac08f266d))


### Features

* **tui:** q/esc quit the viewer (was esc=back) ([1e4bd21](https://github.com/fredcamaral/opencode-drawers/commit/1e4bd21aaee9e1c010d82c7bd48432603d415382))
* **workflows:** TUI run switcher, scrollable tree, upfront phases ([dee4203](https://github.com/fredcamaral/opencode-drawers/commit/dee4203e39cdfa2a4be009a5328abca61dfbeefd))

# 1.0.0 (2026-06-07)


### Bug Fixes

* **core:** one canonical data base dir across plugins — env var is a base, not a leaf ([e8b217f](https://github.com/fredcamaral/opencode-drawers/commit/e8b217f669ea254e937d42311e20c711b7ccc3b0))
* **core:** turn watermark in completion gate — stale previous-turn output can no longer complete a resumed turn ([39f5cc7](https://github.com/fredcamaral/opencode-drawers/commit/39f5cc7a4f44815333dae5b0d436e11400fc6006))
* **core:** turn-liveness veto in completion gate — Task 7.1.1 ([debc65f](https://github.com/fredcamaral/opencode-drawers/commit/debc65faca0934c7429000930e228f104f2e391b))
* **test:** deterministic + race-free conformance (d) poisoned-pipeline ([b83d98f](https://github.com/fredcamaral/opencode-drawers/commit/b83d98f137485418281355feaeed9bbcd15cbb74))
* **workflows:** absolute script_path resolves verbatim ([d08cbc7](https://github.com/fredcamaral/opencode-drawers/commit/d08cbc75fc433573c903b841ceb24cadc02f5b14))
* **workflows:** epic 8.1 review findings ([7ce4154](https://github.com/fredcamaral/opencode-drawers/commit/7ce41547208aca69caec33bd3862166ef98721bf))
* **workflows:** epic 8.2 review findings ([6a860a0](https://github.com/fredcamaral/opencode-drawers/commit/6a860a0fdfe0f1b212efbbdf84d08a44c68ad25a))
* **workflows:** epic 8.3 review findings ([49877a8](https://github.com/fredcamaral/opencode-drawers/commit/49877a86c28654c372ddadb4bdaa07d8211fa04a))
* **workflows:** TUI viewer dual-instance crash — solid/opentui only in .tsx ([551c432](https://github.com/fredcamaral/opencode-drawers/commit/551c432ecf819fccff8230f2d8bdb33282d54e6a))


### Features

* active parent wake on idle — Epic 6.3 ([cae8ed8](https://github.com/fredcamaral/opencode-drawers/commit/cae8ed889062226179252fa1d846d7c024f64678))
* **agents:** bg_output, bg_cancel, bg_list tools + entry registration ([10350e9](https://github.com/fredcamaral/opencode-drawers/commit/10350e9bdb07ec1f60afc958a89e3b688ff3f291))
* **agents:** bg_task tool — launch and resume ([24c7a4f](https://github.com/fredcamaral/opencode-drawers/commit/24c7a4ff45ce683a9189cbb1ce9016536fa1b939))
* **agents:** fork wiring + plugin e2e smoke harness — Phase 2 exit ([dc7c642](https://github.com/fredcamaral/opencode-drawers/commit/dc7c642559a29839d6483a48c08cb8b31e4f3740))
* **agents:** passive notification delivery — chat.message flush + toasts ([d686007](https://github.com/fredcamaral/opencode-drawers/commit/d6860077e6f4398150b21752b986e09fefcc3008))
* **agents:** plugin scaffold + engine factory; sdk adapter extracted to core ([73d8056](https://github.com/fredcamaral/opencode-drawers/commit/73d8056b38689e8a1bed1cb3c617e489f1d70fd5))
* **agents:** pure fork transcript builder ([3ddbd41](https://github.com/fredcamaral/opencode-drawers/commit/3ddbd41563f594b74d02675fd118b2b029dce2de))
* **core+workflows:** onSessionCreated hook, schema registry, ajv validator (Task 3.3.1) ([fe8a9aa](https://github.com/fredcamaral/opencode-drawers/commit/fe8a9aa620d39ab66d948b64129a6f8e60d2b49b))
* **core:** atomic per-task persistence with restart recovery ([e1641b8](https://github.com/fredcamaral/opencode-drawers/commit/e1641b8cccce5fa0935385dbe98368ddf1457ea6))
* **core:** cancel, resume, and output reading on SessionRunner ([9c28bd6](https://github.com/fredcamaral/opencode-drawers/commit/9c28bd612f819355f65bad9243bfaf6fc8381f87))
* **core:** completion gate with synchronous mutex and safety nets ([b934eb6](https://github.com/fredcamaral/opencode-drawers/commit/b934eb60012fe409c90d0f057fae0874aae13d75))
* **core:** ConcurrencyManager with model>provider>default limits ([7054b5f](https://github.com/fredcamaral/opencode-drawers/commit/7054b5f3a2c393b46abe19a8e2221e02ff10dab1))
* **core:** engine type contract, collision-checked ID generator ([bf78496](https://github.com/fredcamaral/opencode-drawers/commit/bf784962912e523e5364f5b8de902dbbebec9ab3))
* **core:** headless smoke harness — engine proven against real opencode ([405a868](https://github.com/fredcamaral/opencode-drawers/commit/405a86872a61839d71a4689a088fdf32a3719816))
* **core:** notification queue with passive-flush contract ([7f8df4b](https://github.com/fredcamaral/opencode-drawers/commit/7f8df4bac56f60dfd7f6b883901a05c5d3c5bd72))
* **core:** SessionRunner launch path with cancellation re-checks ([db43f4b](https://github.com/fredcamaral/opencode-drawers/commit/db43f4baf64ce86f86100501e9a3a981adeaedd7))
* scaffold Bun workspaces monorepo with @drawers/core skeleton ([6abe753](https://github.com/fredcamaral/opencode-drawers/commit/6abe7532a4a9df848ae95a79652960477b538ea7))
* **workflows:** ./tui entrypoint + full-screen Phases|Agents|Detail route with j/k/enter/x/esc — Task 8.3.3 ([476ba11](https://github.com/fredcamaral/opencode-drawers/commit/476ba117c5eeb13bce1a75aa0269ff5932cc5616))
* **workflows:** agent prompt in the TUI Detail pane + `s` stop alias ([a96e6a3](https://github.com/fredcamaral/opencode-drawers/commit/a96e6a328799e95990a03bfd1be9fe52e3da4336))
* **workflows:** agent:launched event + sessionID on agent:end — Task 8.1.1 ([8ca28fa](https://github.com/fredcamaral/opencode-drawers/commit/8ca28fa91c93ca91651ac1ec8d2fff07ab51756a))
* **workflows:** agent() primitive over the core runner (Task 3.2.1) ([d5a06d5](https://github.com/fredcamaral/opencode-drawers/commit/d5a06d568c398c53701a641cb15d57738d90c0c2))
* **workflows:** createWorkflowRun assembly + spec-conformance suite (Task 3.2.3) ([d7e4820](https://github.com/fredcamaral/opencode-drawers/commit/d7e48206b24116218cca187a4d6a2a1f4ad3cdfb))
* **workflows:** deterministic resume — journal-backed replay in the plugin (Task 4.2.2) ([936323e](https://github.com/fredcamaral/opencode-drawers/commit/936323ebcd259ba5e03a5dd62aa14100536ca87b))
* **workflows:** engine control watcher — poll workflow-control/, cancel live runs, consume sentinels — Task 8.2.2 ([070e596](https://github.com/fredcamaral/opencode-drawers/commit/070e5961b6b12c390750995fe36d5aaf4e4eacb9))
* **workflows:** enriched agent:end + per-agent rollup on the RunRecord — Task 8.1.4 ([3e6c455](https://github.com/fredcamaral/opencode-drawers/commit/3e6c455b82b26af55836abd705cf7d8f22fe4f41))
* **workflows:** expand workflow tool description into the authoring contract ([a592262](https://github.com/fredcamaral/opencode-drawers/commit/a592262ba578fd1bbc99806d2df6ae943eafb696))
* **workflows:** feed parser + run-state reducer, shared CC-tree format helpers — Task 8.3.1 ([5e68610](https://github.com/fredcamaral/opencode-drawers/commit/5e68610980105ef58bb245bb5a82a221018275bf))
* **workflows:** feed tailer — fs.watch + poll fallback, line-buffered, feeding the reducer — Task 8.3.2 ([edb4a61](https://github.com/fredcamaral/opencode-drawers/commit/edb4a6150bf0922624d5f18be1e4c1f271420fb2))
* **workflows:** in-session observability — Epic 6.2 ([f3d119a](https://github.com/fredcamaral/opencode-drawers/commit/f3d119a350acc46921a63d7ce51e028843f5f5ff))
* **workflows:** JSONL journal + replay seam in agent() (Task 4.2.1) ([7657670](https://github.com/fredcamaral/opencode-drawers/commit/76576706895c1eaffff59d025239e4e4556c8b09))
* **workflows:** live feed writer — workflow-feed/<runId>.jsonl — Task 8.1.2 ([c0509a9](https://github.com/fredcamaral/opencode-drawers/commit/c0509a932c4ca7f6f2122f5f090943bf5941ef6f))
* **workflows:** per-item journal replay (key + occurrence) — Task 7.3.1 ([bb31d26](https://github.com/fredcamaral/opencode-drawers/commit/bb31d26a8cfe1735e8e4ea0162702875637f2e7f))
* **workflows:** pipeline/parallel composition primitives (Task 3.2.2) ([ef9ee38](https://github.com/fredcamaral/opencode-drawers/commit/ef9ee38e29825df8db9874499dc1f72781e067f6))
* **workflows:** plugin shell + engine + run store + global structured_output (Task 4.1.2) ([a61fe52](https://github.com/fredcamaral/opencode-drawers/commit/a61fe52713b5526a18af30179d0be1f26e6747b4))
* **workflows:** run:cancel-requested feed line + workflow-control subdir constant — Task 8.2.1 ([a67d983](https://github.com/fredcamaral/opencode-drawers/commit/a67d983e43b687da591e1a3874eb1ae42b9d36e2))
* **workflows:** sandboxed body evaluation with determinism guards (Task 3.1.2) ([753147e](https://github.com/fredcamaral/opencode-drawers/commit/753147e8947f020e94238c60a2670eb256081588))
* **workflows:** scaffold package + pure-literal meta parser (Task 3.1.1) ([ef9323b](https://github.com/fredcamaral/opencode-drawers/commit/ef9323b9125066e6aca1407cf3bd52ffe7462a8e))
* **workflows:** session stats collector — tokens + tool calls from the SDK event bus — Task 8.1.3 ([391e3eb](https://github.com/fredcamaral/opencode-drawers/commit/391e3eb64a79204080f0b19b26b32409650c5d78))
* **workflows:** sidebar_content slot summarizing active runs + summarize helper — Task 8.3.4 ([1f9138e](https://github.com/fredcamaral/opencode-drawers/commit/1f9138e3ff8f8d71f497fe8279c15165053ceaef))
* **workflows:** smoke harness Scenario F — external touch cancels a live run end-to-end — Task 8.2.3 ([f0c97f4](https://github.com/fredcamaral/opencode-drawers/commit/f0c97f41955fd421dc877eec5252e72f7e8e835f))
* **workflows:** structured_output tool + agent({schema}) wiring — Phase 3 exit (Task 3.3.2) ([8c06a00](https://github.com/fredcamaral/opencode-drawers/commit/8c06a00a2077ee550ddc11ac298beb05a7f63c6d))
* **workflows:** sub-workflows + live e2e smoke harness — Phase 4 exit (Task 4.3.2) ([c0603b1](https://github.com/fredcamaral/opencode-drawers/commit/c0603b1629a674f24bfe12581c0248bbf6308af9))
* **workflows:** token budget provider from real SDK token usage (Task 4.3.1) ([8d07a80](https://github.com/fredcamaral/opencode-drawers/commit/8d07a80e41774d0fc4fd00635897f844d059bebb))
* **workflows:** TUI viewer — CC-style tree, arrow nav, ctrl+o open ([aa8e9f5](https://github.com/fredcamaral/opencode-drawers/commit/aa8e9f5c88e3833ab949c5b51e78415a2aadc0e6))
* **workflows:** typed null diagnostics + untruncated results — Epic 7.2 ([8edc4bf](https://github.com/fredcamaral/opencode-drawers/commit/8edc4bf3c32872a1918dfb3d4952d7cff3658091)), closes [2/#3](https://github.com/fredcamaral/opencode-drawers/issues/3) [#1](https://github.com/fredcamaral/opencode-drawers/issues/1)
* **workflows:** workflow_status CC-style phase tree with per-agent stats — Task 8.1.5 ([a7a217c](https://github.com/fredcamaral/opencode-drawers/commit/a7a217c2f48ec35686ebf233432b2e5c7d9c8ed4))
* **workflows:** workflow/workflow_status/workflow_stop tools + saved workflows (Task 4.1.3) ([f157126](https://github.com/fredcamaral/opencode-drawers/commit/f157126bde6f48f199bbff4923b5c1405edff2d6))
