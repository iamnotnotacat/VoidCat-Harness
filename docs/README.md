# VoidCat technical documentation

These files describe VoidCat's runtime contracts, operator procedures, and release evidence. They are documentation, not executable tests. The actual regression suite is under [`tests/`](../tests/).

## Hunter-Seeker architecture

- [`DESIGN_TOKENS.md`](hunter-seeker/DESIGN_TOKENS.md) - visual, typography, map, status, spacing, and motion contract.
- [`DATA_ATTRIBUTION.md`](hunter-seeker/DATA_ATTRIBUTION.md) - map and provider attribution requirements.
- [`FEED_REGISTRY.md`](hunter-seeker/FEED_REGISTRY.md) - source capabilities, ceilings, and supported behavior.
- [`HUNTER_SEEKER_ADAPTERS.md`](hunter-seeker/HUNTER_SEEKER_ADAPTERS.md) - adapter behavior and normalization.
- [`HUNTER_SEEKER_INVENTORY.md`](hunter-seeker/HUNTER_SEEKER_INVENTORY.md) - implemented and deferred scope.
- [`HUNTER_SEEKER_SMOKE_TEST.md`](hunter-seeker/HUNTER_SEEKER_SMOKE_TEST.md) - bounded manual smoke test.
- [`HUNTER_SEEKER_STAGE_FIVE.md`](hunter-seeker/HUNTER_SEEKER_STAGE_FIVE.md) - watchlist, trigger, health, and replay contract.
- [`HISTORICAL_OBSERVATIONS_AND_RAG.md`](hunter-seeker/HISTORICAL_OBSERVATIONS_AND_RAG.md) - bounded history and historical RAG.
- [`TOOL_REGISTRY.md`](hunter-seeker/TOOL_REGISTRY.md) - shared tool-discovery and invocation contract.
- [`JOB_MANAGER.md`](hunter-seeker/JOB_MANAGER.md) - bounded jobs, progress, accounting, and cancellation.
- [`STORAGE_BUDGET_MANAGER.md`](hunter-seeker/STORAGE_BUDGET_MANAGER.md) - storage accounting and safe cleanup contract.

## OSINT architecture and operation

- [`OSINT_ARCHITECTURE_ASSESSMENT.md`](osint/OSINT_ARCHITECTURE_ASSESSMENT.md)
- [`OSINT_PASSIVE_ONLY_POLICY.md`](osint/OSINT_PASSIVE_ONLY_POLICY.md)
- [`OSINT_TEST_SAFETY.md`](osint/OSINT_TEST_SAFETY.md)
- [`OSINT_CORE_CONTRACTS.md`](osint/OSINT_CORE_CONTRACTS.md)
- [`OSINT_MOCKED_VERTICAL_SLICE.md`](osint/OSINT_MOCKED_VERTICAL_SLICE.md)
- [`OSINT_GATE_3_PERSISTENCE.md`](osint/OSINT_GATE_3_PERSISTENCE.md)
- [`OSINT_GATE_4_PROVIDERS.md`](osint/OSINT_GATE_4_PROVIDERS.md)
- [`OSINT_GATE_5_CORRELATION_CONFIDENCE.md`](osint/OSINT_GATE_5_CORRELATION_CONFIDENCE.md)
- [`OSINT_GATE_6_CONTROLLED_EXPANSION.md`](osint/OSINT_GATE_6_CONTROLLED_EXPANSION.md)
- [`OSINT_GATE_7_HUNTER_SEEKER_INTEGRATION.md`](osint/OSINT_GATE_7_HUNTER_SEEKER_INTEGRATION.md)
- [`OSINT_GATE_8_ACTIVE_UNIT_TOOLS.md`](osint/OSINT_GATE_8_ACTIVE_UNIT_TOOLS.md)
- [`OSINT_GATE_9_INVESTIGATION_UI.md`](osint/OSINT_GATE_9_INVESTIGATION_UI.md)
- [`OSINT_GATE_10_HARDENING_ACCEPTANCE.md`](osint/OSINT_GATE_10_HARDENING_ACCEPTANCE.md)
- [`OSINT_OPERATOR_GUIDE.md`](osint/OSINT_OPERATOR_GUIDE.md)
- [`OSINT_DIRECTORY.md`](osint/OSINT_DIRECTORY.md)

## Operator and distribution contracts

- [`SECURE_CREDENTIAL_STORAGE.md`](operator/SECURE_CREDENTIAL_STORAGE.md) - protected credential boundary.
- [`CPAL_ATTRIBUTION.md`](operator/CPAL_ATTRIBUTION.md) - required launch attribution and source-availability contract.
- [`VOIDCAT_INTELLIGENCE_VOICE_PROJECTS.md`](operator/VOIDCAT_INTELLIGENCE_VOICE_PROJECTS.md) - capability selection, voice, projects, news, settings, and distribution.

## Historical audit evidence

The files under [`audits/`](audits/) record point-in-time development gates and test baselines. They are retained for traceability and are not claims about a newer checkout unless their date and commit match it:

- [`HUNTER_SEEKER_READINESS.md`](audits/HUNTER_SEEKER_READINESS.md)
- [`OSINT_GATE_0_BASELINE.md`](audits/OSINT_GATE_0_BASELINE.md)
- [`OSINT_GATES_0_2_AUDIT.md`](audits/OSINT_GATES_0_2_AUDIT.md)
- [`OSINT_GATES_0_4_DEPLOYMENT_AUDIT.md`](audits/OSINT_GATES_0_4_DEPLOYMENT_AUDIT.md)
- [`STORAGE_BUDGET_SYNTHETIC_REPORT.md`](audits/STORAGE_BUDGET_SYNTHETIC_REPORT.md)
- [`VOIDCAT_AUDIT_2026-07-28.md`](audits/VOIDCAT_AUDIT_2026-07-28.md)
