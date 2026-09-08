# VerseLink Companion – Phase 0

Isolated local screenshot to OCR to mining parser to JSON feasibility prototype. No VerseLink integration is included.

Phase 0 performs no network, database, login, token, upload, API, process-memory, injection, hook, overlay, or game-file operation. Screenshots remain local.

The WinForms UI offers local PNG/JPG/JPEG loading, primary-screen capture, raw OCR/debug output, parsed rows, warnings, and local JSON export. OCR uses the local Microsoft Windows.Media.Ocr API through Microsoft.Windows.SDK.NET.Ref. This repository environment has no .NET SDK, so build/test execution is not possible here. Full-screen capture is implemented; interactive crop selection is not.

Requirements: Windows 10/11 and .NET 8 SDK.

    dotnet build VerseLink.Companion.sln
    dotnet test VerseLink.Companion.sln
    dotnet run --project src/VerseLink.Companion

Own screenshots may be placed in testdata/images with expected JSON in testdata/expected. No external screenshots are copied.

Out of scope: VerseLink sync, Game.log, pairing, HTTP, PostgreSQL, productive catalog, import, and authentication.

## Phase 0.5 test workflow

1. Start VerseLink.Companion.exe.
2. Open the refinery screenshot.
3. Define the Location Region.
4. Define the Work Order Region.
5. Click Analyze.
6. Compare the parsed rows and warnings.
7. Export the local JSON result.

## Windows publish

From the repository root:

    dotnet publish companion/src/VerseLink.Companion/VerseLink.Companion.csproj -c Release -r win-x64 --self-contained false -o companion/artifacts/win-x64

Start companion/artifacts/win-x64/VerseLink.Companion.exe. This framework-dependent build requires the .NET 8 Desktop Runtime. Image processing remains local.

## Automatic log export

After every successful analysis, a JSON result is written automatically to a `logs` folder beside the executable. The folder is created automatically if it does not exist. The filename is based on the analyzed screenshot, for example:

    logs/Screenshot-123.json

The option `Copy analyzed screenshot` is enabled by default. When enabled, the original analyzed image is copied to the same `logs` folder:

    logs/Screenshot-123.jpg

The image copy can be disabled in the UI; JSON export remains active. `Export JSON` can still be used for an additional manually selected export location.

## Automatic screenshot folder watch

The automatic UI can watch a configurable local folder for new screenshots. The default is:

    O:\Roberts Space Industries\StarCitizen\LIVE\screenshots

Edit the path in `Screenshot folder:` and click `Start Folder Watch`. New `.png`, `.jpg`, or `.jpeg` files are loaded after a short write-delay and passed through the existing automatic OCR/parser workflow. Click `Stop Folder Watch` to disable it. Files are processed locally and are not uploaded.
