# Third-party notices

This project's own code is under the MIT licence in [LICENSE](LICENSE). The Windows package, which comes as two zips
(the package `rpa-windows-x64.zip` and the browser package `rpa-browser-windows-x64.zip`), the browser image
(`rpa-browser`) and the npm package (`n8n-nodes-rpa`) also bring or depend on software by others, under the licences
listed here. This file says where each part comes from and where its licence texts are. It is not legal advice.

Each of the two zips carries a copy of its own section of this file, and the licence and notice texts of what that
section lists, one folder per component: the package has them at its top, in `THIRD-PARTY-NOTICES.md` and
`licenses\`, and the browser package in `browser\THIRD-PARTY-NOTICES.md` and `browser\licenses\`. An install without
the browser has the package's only. The build (`desktop/installer/build/Stage.ps1`) copies the texts from the
components it puts into each zip, so they belong to the versions in that zip, and it stops when an expected file is
missing. The table at the end of each copy lists every folder and file.

## The Windows package (`rpa-windows-x64.zip`)

| Component | Version | Licence | Where it is in the package | Its texts in `licenses\`, and where they come from |
|---|---|---|---|---|
| .NET 8 runtime: Microsoft.NETCore.App, Microsoft.AspNetCore.App, Microsoft.WindowsDesktop.App | the 8.0 runtime of the .NET SDK that built the package (named in the table at the end) | MIT | inside the self-contained programs `runner\RpaRunner.exe`, `runner\RpaSupervisor.exe`, `runner\RpaPolicy.exe`, `recorder\RpaRecorder.exe` and `erp-demo\v1\ErpDemo.exe`, `erp-demo\v2\ErpDemo.exe` | One folder per runtime pack (`Microsoft.*.Runtime.win-x64`), with the LICENSE and THIRD-PARTY-NOTICES files of the NuGet package. The ASP.NET Core pack carries THIRD-PARTY-NOTICES.TXT and no LICENSE; its licence is the same MIT text, "Copyright (c) .NET Foundation and Contributors", as the LICENSE.TXT of Microsoft.NETCore.App.Runtime.win-x64 (and the LICENSE.txt of `https://github.com/dotnet/aspnetcore`). |
| FlaUI.Core, FlaUI.UIA3 | 5.0.0 | MIT | inside `RpaRunner.exe` and `RpaRecorder.exe` | `FlaUI.Core-5.0.0\` and `FlaUI.UIA3-5.0.0\`: LICENSE.txt from the NuGet packages |
| Interop.UIAutomationClient (FlaUI's UI Automation interop) | 10.19041.0 | MIT | inside `RpaRunner.exe` and `RpaRecorder.exe` | `Interop.UIAutomationClient-10.19041.0\LICENSE.txt`, from the NuGet package |
| System.Drawing.Common | 8.0.10 | MIT | inside `RpaRunner.exe` and `RpaRecorder.exe` | LICENSE.TXT and THIRD-PARTY-NOTICES.TXT from the NuGet package |
| System.Security.Cryptography.ProtectedData | 8.0.0 | MIT | inside `RpaRunner.exe` and `RpaRecorder.exe` | LICENSE.TXT and THIRD-PARTY-NOTICES.TXT from the NuGet package |
| System.ServiceProcess.ServiceController | 8.0.1 | MIT | inside `RpaSupervisor.exe` | LICENSE.TXT and THIRD-PARTY-NOTICES.TXT from the NuGet package |
| The Microsoft packages FlaUI and those above depend on (System.Management, System.Diagnostics.EventLog, System.Diagnostics.PerformanceCounter, System.Configuration.ConfigurationManager, System.CodeDom, System.Security.Permissions, System.Windows.Extensions, Microsoft.Win32.SystemEvents and others) | the versions the restore picked (named in the table at the end) | MIT | inside the programs that use them | LICENSE.TXT and THIRD-PARTY-NOTICES.TXT from each NuGet package |

The NuGet packages in `licenses\` are those with code for Windows x64 in the restore of each published program
(`obj\project.assets.json`), and the runtime packs the programs were published with. Where the .NET runtime has its own
copy of a library, the program may use that copy instead.

## The browser package (`rpa-browser-windows-x64.zip`)

It is unpacked into the package's folder: its files are in `browser\` there, with `scripts\start-browser.ps1`.

| Component | Version | Licence | Where it is in the package | Its texts in `browser\licenses\`, and where they come from |
|---|---|---|---|---|
| Node.js | 22.23.4 | MIT, and the licences of the libraries Node.js builds in (V8, OpenSSL, ICU, libuv, undici and others), all in its LICENSE | `browser\node.exe` | `node-22.23.4\LICENSE`, from the Node.js zip (`https://nodejs.org/dist/v22.23.4/node-v22.23.4-win-x64.zip`) |
| Playwright (`playwright`, `playwright-core`) | 1.63.0 | Apache-2.0 | `browser\node_modules\` | `playwright-1.63.0\` and `playwright-core-1.63.0\`: LICENSE, NOTICE and ThirdPartyNotices.txt from the npm packages. The code they bundle from other npm packages is listed, with its licences, in the `*.LICENSE` files beside it in `browser\node_modules\playwright*\lib\`. |
| Google Chrome for Testing | 153.0.8010.12 (Playwright's chromium build 1243) | Built by Google from Chromium (BSD-3-Clause) and its third-party parts. Its ABOUT file reads "Copyright 2026 Google LLC. All rights reserved." and points to chrome://credits and chrome://terms. | `browser\ms-playwright\chromium-1243\` | `chrome-for-testing-153.0.8010.12\ABOUT`, from the build. Its credits show in the browser at chrome://credits. |
| Chrome Headless Shell | 153.0.8010.12 (Playwright's chromium-headless-shell build 1243) | Chromium's BSD-3-Clause licence and the licences of its third-party parts, among them FFmpeg (LGPL-2.1-or-later), which Chromium builds in | `browser\ms-playwright\chromium_headless_shell-1243\` | `chrome-headless-shell-153.0.8010.12\LICENSE.headless_shell`, from the build: Chromium's licence followed by those of its third-party parts |
| PrintDeps.exe (Playwright's winldd) | build 1007 | MIT (Copyright (c) 2020 Julien Waechter) and Apache-2.0 (Microsoft Corporation) | `browser\ms-playwright\winldd-1007\` | `winldd-1007\LICENSE.txt`. The build carries no licence file; this repository keeps the two licence headers of its source, `browser_patches/winldd/PrintDeps.cpp` in `https://github.com/microsoft/playwright` at v1.63.0, in `desktop/installer/build/notices/winldd-1007/`. |

Not in the package:

- **Playwright's FFmpeg build** (`ffmpeg-1011`, LGPL-2.1). Playwright's installer downloads it with Chromium, and
  Playwright uses it only to record video of a browser session. Nothing in RPA records video, so `Stage.ps1` removes it
  after checking the downloaded files. A Playwright client that asks this browser for a video gets Playwright's error
  that the FFmpeg executable does not exist.
- **npm**, which comes with Node.js: the build uses it to install Playwright, and it is not shipped.

Chromium's own source, including the FFmpeg it builds in (`third_party/ffmpeg`), is at
`https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12`.

## The browser image

The image is built `FROM mcr.microsoft.com/playwright:v1.63.0` (Ubuntu 24.04, pinned by digest in
`images/browser/Dockerfile`). That base image brings Ubuntu's packages, each with its copyright file in
`/usr/share/doc/<package>/`, Node.js from NodeSource, and Playwright's browsers in `/ms-playwright` (Chromium, Chrome
Headless Shell, Firefox, WebKit and Playwright's FFmpeg build), each with the licence files its build carries. The
image adds:

| Component | Version | Licence | Its texts in the image |
|---|---|---|---|
| tini | 0.19.0-1 (Ubuntu package) | MIT | `/usr/share/doc/tini/copyright` |
| Playwright (`playwright`, `playwright-core`) | 1.63.0 | Apache-2.0 | LICENSE, NOTICE and ThirdPartyNotices.txt in `/opt/rpa-browser/server/node_modules/playwright*/` |

## The npm package

`n8n-nodes-rpa` holds this project's code only (`dist/` and `templates/`, with its LICENSE). npm installs its
dependencies from the registry, each package with its own files: `playwright-core` 1.63.0 (Apache-2.0), `fflate`
0.8.3 (MIT) and `redis` 6.3.0 (MIT), with what they depend on.
