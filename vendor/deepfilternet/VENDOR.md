# DeepFilterNet vendor record

- Upstream: https://github.com/Rikorose/DeepFilterNet
- Pinned commit: d375b2d8309e0935d165700c91da9de862a99c31
- Vendored at (UTC): 2026-07-09T18:08:57Z
- Contents: `libDF/`, `models/DeepFilterNet3_onnx.tar.gz`, `LICENSE-MIT`, and `LICENSE-APACHE`.

## Reviewed local compatibility and WASM performance patch

- `libDF/` carries the WASM compatibility/performance changes from
  `czoli1976/DeepFilterNet@143b040471f38e860853f5e64116bb67ea48d793`
  (`dfn3-wasm-opt-tract-022-kernel-kit`) and pins the tract dependency family
  to `=0.23.3`.
- The patch uses tract's re-exported ndarray types at the model boundary and
  includes the branch's allocation/SIMD-friendly frame-processing changes.
- The DeepFilterNet3 model archive is unchanged. Its SHA-256 is
  `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616`.
- The previously distributed Web 0.23.3 reference artefact came from
  `mezonai/mezon-noise-suppression@9811b07d1eee990b5fef745c06cc1eeef13bf8b1`.

## Upgrade procedure

1. Review the upstream release/commit and its license notices in a dedicated
   maintenance change.
2. Preserve and rebase the reviewed local compatibility/performance changes;
   do not replace this tree by running the original one-time vendor helper.
3. Inspect `libDF/Cargo.toml` and the lockfile. The tract family must be pinned
   exactly and production builds must not contain git dependencies.
4. Regenerate `vendor/cargo` from the reviewed lockfile into a clean directory.
5. Rebuild every affected platform artifact, stage the publishable package
   copies, and regenerate the artifact checksum manifest before release.

Normal local, package, application, and CI builds must not clone, download, or
otherwise fetch DeepFilterNet. The complete reviewed source and Cargo vendor
tree are versioned with the prebuilt artifacts.
