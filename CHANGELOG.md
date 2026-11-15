# Changelog

## 0.1.0 (2026-11-15)


### Features

* apply migrations in CI and check pull requests for destructive ones ([#14](https://github.com/PatchFarm/the-hollow/issues/14)) ([fc43bc8](https://github.com/PatchFarm/the-hollow/commit/fc43bc8b9496fe02fdedba195ed0a7706571df4e))
* deploy Cloudflare Workers and Pages, staged on merge and promoted on release ([#11](https://github.com/PatchFarm/the-hollow/issues/11)) ([e3bb062](https://github.com/PatchFarm/the-hollow/commit/e3bb0621c94f69a4d820433ab0fb104c91002602))
* deploy Docker and VPS targets to staging on merge and production on release ([#9](https://github.com/PatchFarm/the-hollow/issues/9)) ([de46cc0](https://github.com/PatchFarm/the-hollow/commit/de46cc0510d628c37b495886ea80032f1f8181cd))
* deploy Vercel targets as a staged production build, promoted on release ([#10](https://github.com/PatchFarm/the-hollow/issues/10)) ([3933a87](https://github.com/PatchFarm/the-hollow/commit/3933a87c150403bc97fd3f275b9fbd2b90abe1a3))
* gate production on required reviewers, with a manual run as the approval ([#12](https://github.com/PatchFarm/the-hollow/issues/12)) ([0039179](https://github.com/PatchFarm/the-hollow/commit/0039179081d0f43bf40049df1374f270efeeffc2))
* generate dev-workflow files and a Conventional Commits PR title check ([#5](https://github.com/PatchFarm/the-hollow/issues/5)) ([0812a0d](https://github.com/PatchFarm/the-hollow/commit/0812a0d1020b486463d80815298a4af630243a57))
* generate release.yml with release-please, one artifact, SBOM and provenance ([#6](https://github.com/PatchFarm/the-hollow/issues/6)) ([c7d2012](https://github.com/PatchFarm/the-hollow/commit/c7d20120f39c5629c2d10d70d75261a78b55b405))
* guardrails for the agent: workflow policy, log redaction and an edit allowlist ([#16](https://github.com/PatchFarm/the-hollow/issues/16)) ([4784b6e](https://github.com/PatchFarm/the-hollow/commit/4784b6e6a34db0b4597ef16898df892483a6a173))
* hollow check runs the CI checks locally ([#4](https://github.com/PatchFarm/the-hollow/issues/4)) ([beae425](https://github.com/PatchFarm/the-hollow/commit/beae42545dfa2e928507d6d9362aa1956022379b))
* hollow doctor audits the pipeline, read-only ([#20](https://github.com/PatchFarm/the-hollow/issues/20)) ([9953be2](https://github.com/PatchFarm/the-hollow/commit/9953be29be2548a18cdca201daa4a850578483e7))
* hollow fix publishes the pipeline, watches its checks and explains failures ([#17](https://github.com/PatchFarm/the-hollow/issues/17)) ([4fb82b0](https://github.com/PatchFarm/the-hollow/commit/4fb82b05e2cfd76363c4f9369b77653543a18006))
* hollow fix repairs the pipeline with the model you configure ([#18](https://github.com/PatchFarm/the-hollow/issues/18)) ([9f8510e](https://github.com/PatchFarm/the-hollow/commit/9f8510eb02eef65d0634800767e961e38c796f30))
* hollow protect applies branch rules, environments and security settings ([#7](https://github.com/PatchFarm/the-hollow/issues/7)) ([37612c2](https://github.com/PatchFarm/the-hollow/commit/37612c2f887b4f292049d52dcd8f68dcbab58cb1))
* hollow secrets lists what the pipeline needs and sets the missing values ([#13](https://github.com/PatchFarm/the-hollow/issues/13)) ([f8dc514](https://github.com/PatchFarm/the-hollow/commit/f8dc51433d8d2c3d8dc6bb4ca624dabd675df99e))
* M0 foundation (CLI skeleton, detector, hollow.yml schema, fixtures) ([#1](https://github.com/PatchFarm/the-hollow/issues/1)) ([43b1b81](https://github.com/PatchFarm/the-hollow/commit/43b1b8124b2fddb74fad4118ecadf556bb52e0aa))
* M1 CI generator with hollow init and hollow upgrade ([#3](https://github.com/PatchFarm/the-hollow/issues/3)) ([256db34](https://github.com/PatchFarm/the-hollow/commit/256db34abf6d591413653f3c9f078a7110be6e10))
* migrate each environment's database before its deploy, with a VPS backup first ([#15](https://github.com/PatchFarm/the-hollow/issues/15)) ([bde2b4f](https://github.com/PatchFarm/the-hollow/commit/bde2b4f91a332f36eef583b51cb3ccd45bf483bb))
* scheduled checks, incident issues, alerts and a generated PIPELINE.md ([#19](https://github.com/PatchFarm/the-hollow/issues/19)) ([a2d7c0b](https://github.com/PatchFarm/the-hollow/commit/a2d7c0bb3de2b7b87eba20f59b28d19ba9f5e2be))


### Bug Fixes

* **release:** make the first release 0.1.0, not 1.0.0 ([#22](https://github.com/PatchFarm/the-hollow/issues/22)) ([8b46ed1](https://github.com/PatchFarm/the-hollow/commit/8b46ed101afc4cec2dbd031cb00db6421e0c7959))
