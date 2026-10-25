# Third-party notices

WebDecryptHub's own code is MIT licensed. This does not relicense vendored code, dependencies, Chromium or CloakBrowser binaries.

## Vendored js-reverse-mcp

Source: https://github.com/zhizhuodemao/js-reverse-mcp

Location: `src/vendor/core-build/` (upstream package metadata in `pkg.json`, version 4.0.5).

License: Apache-2.0, retained at `src/vendor/core-build/LICENSE`. The distribution NOTICE is at `src/vendor/core-build/NOTICE`; source headers, including Google LLC copyrights, remain in place. Local integration modifications include CDP targetId-based page selection and are marked in the changed file. Source extraction provenance is recorded in SOURCE_PROVENANCE.md. This is a downstream integration, not an upstream release or endorsement.

## Selected runtime dependencies

- @zhizhuodemao/patchright: Apache-2.0; browser automation.
- @modelcontextprotocol/sdk, ws, zod, yauzl: MIT; MCP, transport, schemas and archives.
- @babel/*, webcrack, jsdom: MIT; upstream analysis utilities.
- Other packages retain their installed LICENSE / NOTICE files. The component builder preserves them when copying production dependencies.

## Browser binaries

CloakBrowser wrapper code and its browser binaries have separate terms. See the official source and binary license at https://github.com/CloakHQ/cloakbrowser. Users obtain kernels separately; neither this repository nor the component builder redistributes them. Kernel download is optional and explicit. Chromium and Chrome for Testing retain their upstream licenses.
