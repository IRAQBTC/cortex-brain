<#
  Cortex capability check
  -----------------------
  Read-only by default. It does NOT run the scanner, does NOT touch the quarantined
  legacy tools, and opens the SQLite database in read-only mode.

  Usage (PowerShell):
    .\cortex-check.ps1                          # static + environment + DB checks
    .\cortex-check.ps1 -RunTests                # also runs npm test and npm run test:extension
    .\cortex-check.ps1 -LiveApi                 # also calls every GET endpoint on a running server
    .\cortex-check.ps1 -RunTests -LiveApi -BaseUrl http://localhost:3000

  If scripts are blocked:
    powershell -ExecutionPolicy Bypass -File .\cortex-check.ps1
#>
[CmdletBinding()]
param(
    [string]$ProjectRoot = 'E:\AI\Cortex',
    [string]$BaseUrl     = 'http://localhost:3000',
    [switch]$RunTests,
    [switch]$LiveApi
)

$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.Generic.List[object]

function Add-Result {
    param([string]$Area, [string]$Check, [string]$Status, [string]$Detail = '')
    $script:results.Add([pscustomobject]@{ Area = $Area; Check = $Check; Status = $Status; Detail = $Detail })
    $color = switch ($Status) { 'PASS' { 'Green' } 'WARN' { 'Yellow' } 'FAIL' { 'Red' } default { 'Gray' } }
    Write-Host ("[{0}] {1} / {2}  {3}" -f $Status, $Area, $Check, $Detail) -ForegroundColor $color
}

function Get-FirstLine([string]$text) {
    if (-not $text) { return '' }
    return ($text -split "`r?`n")[0]
}

if (-not (Test-Path -LiteralPath $ProjectRoot)) {
    Write-Host "Project root not found: $ProjectRoot" -ForegroundColor Red
    exit 1
}
Set-Location -LiteralPath $ProjectRoot

$reportDir = Join-Path $ProjectRoot '.cortex\reports'
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tmp = Join-Path $env:TEMP "cortex-check-$stamp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host ""
Write-Host "=== Cortex capability check: $ProjectRoot ===" -ForegroundColor Cyan

# ---------------------------------------------------------------- 1. Environment
Write-Host "`n--- 1. Environment ---" -ForegroundColor Cyan

$nodeVer = $null
try { $nodeVer = (& node -v 2>$null) } catch {}
if ($nodeVer) { Add-Result 'Env' 'node' 'PASS' $nodeVer } else { Add-Result 'Env' 'node' 'FAIL' 'node not found in PATH' }

$npmVer = $null
try { $npmVer = (& npm -v 2>$null) } catch {}
if ($npmVer) { Add-Result 'Env' 'npm' 'PASS' $npmVer } else { Add-Result 'Env' 'npm' 'WARN' 'npm not found in PATH' }

$pnpmVer = $null
try { $pnpmVer = (& pnpm -v 2>$null) } catch {}
if ($pnpmVer) { Add-Result 'Env' 'pnpm' 'INFO' $pnpmVer } else { Add-Result 'Env' 'pnpm' 'INFO' 'not installed' }

$hasPnpmLock = Test-Path -LiteralPath (Join-Path $ProjectRoot 'pnpm-lock.yaml')
$hasNpmLock  = Test-Path -LiteralPath (Join-Path $ProjectRoot 'package-lock.json')
if ($hasPnpmLock -and -not $hasNpmLock) {
    Add-Result 'Env' 'lockfile' 'WARN' 'pnpm-lock.yaml exists but package-lock.json does not, while docs use npm commands'
} elseif ($hasPnpmLock -and $hasNpmLock) {
    Add-Result 'Env' 'lockfile' 'WARN' 'both pnpm-lock.yaml and package-lock.json exist'
} else {
    Add-Result 'Env' 'lockfile' 'INFO' ("pnpm=$hasPnpmLock npm=$hasNpmLock")
}

$pkgPath = Join-Path $ProjectRoot 'package.json'
if (Test-Path -LiteralPath $pkgPath) {
    try {
        $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
        Add-Result 'Env' 'package.json' 'PASS' ("{0}@{1}" -f $pkg.name, $pkg.version)
    } catch {
        Add-Result 'Env' 'package.json' 'FAIL' 'cannot parse package.json'
    }
} else {
    Add-Result 'Env' 'package.json' 'FAIL' 'missing'
}

if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules')) {
    Add-Result 'Env' 'node_modules' 'PASS' 'present'
} else {
    Add-Result 'Env' 'node_modules' 'FAIL' 'missing - run: npm install'
}

$gitOk = $false
try { $null = & git rev-parse --is-inside-work-tree 2>$null; if ($LASTEXITCODE -eq 0) { $gitOk = $true } } catch {}
if ($gitOk) {
    $changed = @(& git status --short 2>$null).Count
    Add-Result 'Env' 'git' 'PASS' "repository detected, $changed changed path(s)"
} else {
    Add-Result 'Env' 'git' 'WARN' 'not a git repository (change-intelligence will not work)'
}

# ---------------------------------------------------------------- 2. File inventory
Write-Host "`n--- 2. Files ---" -ForegroundColor Cyan

$exclude = '\\(node_modules|\.git|\.cortex|dist|build|coverage)\\'
$allFiles = Get-ChildItem -LiteralPath $ProjectRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch $exclude }
$byExt = $allFiles | Group-Object Extension | Sort-Object Count -Descending | Select-Object -First 8
Add-Result 'Files' 'total (excluding node_modules/.git/.cortex)' 'INFO' ([string]$allFiles.Count)
Add-Result 'Files' 'by extension' 'INFO' (($byExt | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ', ')

$keyFiles = 'server.js','scanner.js','parser.js','db.js','call-graph.js','blast-radius.js','verify.js',
            'handoff-generator.js','mcp-server.mjs','public\index.html','vscode-extension\extension.js'
foreach ($f in $keyFiles) {
    if (Test-Path -LiteralPath (Join-Path $ProjectRoot $f)) { Add-Result 'Files' $f 'PASS' 'present' }
    else { Add-Result 'Files' $f 'WARN' 'missing' }
}

foreach ($legacy in 'scanner.py','universal_scanner.py') {
    if (Test-Path -LiteralPath (Join-Path $ProjectRoot $legacy)) {
        Add-Result 'Safety' $legacy 'WARN' 'legacy scanner is in the project root - it must stay quarantined, never run it'
    }
}
$quarantine = Join-Path $ProjectRoot '.cortex\quarantine'
if (Test-Path -LiteralPath $quarantine) {
    $q = @(Get-ChildItem -LiteralPath $quarantine -File -ErrorAction SilentlyContinue).Count
    Add-Result 'Safety' 'quarantine folder' 'INFO' "$q file(s), not executed by this script"
}

$testFiles = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'tests') -Filter *.test.js -ErrorAction SilentlyContinue)
Add-Result 'Files' 'test files' 'INFO' ([string]$testFiles.Count)

# ---------------------------------------------------------------- 3. Native modules, parser, call graph
Write-Host "`n--- 3. Dependencies, parser, call graph ---" -ForegroundColor Cyan

$probeJs = @'
const path = require('path');
const fs = require('fs');
const root = process.argv[2];
const outFile = process.argv[3];
const out = { modules: {}, parser: {}, callGraph: {} };

function tryLoad(name) {
  try { require(require.resolve(name, { paths: [root] })); return 'ok'; }
  catch (e) { return 'FAIL: ' + String(e.message).split('\n')[0]; }
}
for (const m of ['better-sqlite3', 'tree-sitter', 'tree-sitter-javascript', 'tree-sitter-python',
                 'express', 'dotenv', 'vitest', '@modelcontextprotocol/sdk']) {
  out.modules[m] = tryLoad(m);
}

function summarize(r) {
  if (Array.isArray(r)) return 'array(' + r.length + ')';
  if (r && typeof r === 'object') {
    return Object.keys(r).map(k => k + ':' + (Array.isArray(r[k]) ? 'array(' + r[k].length + ')' : typeof r[k])).join(', ');
  }
  return typeof r;
}

const js = 'function a() { b(); }\nfunction b() {}\nclass C { m() { a(); } }\nconst f = () => a();\n';
const py = 'def a():\n    b()\n\ndef b():\n    pass\n\nclass C:\n    def m(self):\n        a()\n';

try {
  const P = require(path.join(root, 'parser.js'));
  const Cls = P.CortexParser || P;
  const p = new Cls();
  for (const [lang, src] of [['javascript', js], ['python', py]]) {
    try { out.parser[lang] = 'ok: ' + summarize(p.parseCode(src, lang)); }
    catch (e) { out.parser[lang] = 'FAIL: ' + String(e.message).split('\n')[0]; }
  }
} catch (e) {
  out.parser.load = 'FAIL: ' + String(e.message).split('\n')[0];
}

try {
  const cg = require(path.join(root, 'call-graph.js'));
  const fn = cg.extractLocalCalls;
  if (typeof fn !== 'function') {
    out.callGraph.load = 'FAIL: extractLocalCalls is not exported';
  } else {
    for (const [lang, src] of [['javascript', js], ['python', py]]) {
      try { out.callGraph[lang] = 'ok: ' + summarize(fn(src, lang)); }
      catch (e) { out.callGraph[lang] = 'FAIL: ' + String(e.message).split('\n')[0]; }
    }
  }
} catch (e) {
  out.callGraph.load = 'FAIL: ' + String(e.message).split('\n')[0];
}

fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
'@

$probeFile = Join-Path $tmp 'probe.cjs'
$probeOut  = Join-Path $tmp 'probe.json'
Set-Content -LiteralPath $probeFile -Value $probeJs -Encoding UTF8

if ($nodeVer) {
    & node $probeFile $ProjectRoot $probeOut 2>&1 | Out-Null
    if (Test-Path -LiteralPath $probeOut) {
        $probe = Get-Content -LiteralPath $probeOut -Raw | ConvertFrom-Json
        foreach ($p in $probe.modules.PSObject.Properties) {
            if ($p.Value -eq 'ok') { Add-Result 'Modules' $p.Name 'PASS' 'loads' }
            else { Add-Result 'Modules' $p.Name 'FAIL' $p.Value }
        }
        foreach ($p in $probe.parser.PSObject.Properties) {
            if ($p.Value -like 'ok*') { Add-Result 'Parser' $p.Name 'PASS' $p.Value }
            else { Add-Result 'Parser' $p.Name 'FAIL' $p.Value }
        }
        foreach ($p in $probe.callGraph.PSObject.Properties) {
            if ($p.Value -like 'ok*') { Add-Result 'CallGraph' $p.Name 'PASS' $p.Value }
            else { Add-Result 'CallGraph' $p.Name 'FAIL' $p.Value }
        }
    } else {
        Add-Result 'Modules' 'probe' 'FAIL' 'node probe produced no output'
    }
}

# ---------------------------------------------------------------- 4. Database and index freshness
Write-Host "`n--- 4. Database and index ---" -ForegroundColor Cyan

$dbJs = @'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const outFile = process.argv[3];
const candidates = process.argv.slice(4);
const out = { dbPath: null, error: null };

try {
  let dbPath = null;
  try {
    const m = require(path.join(root, 'db-path.js'));
    out.dbPathExports = (typeof m === 'object' || typeof m === 'function') ? Object.keys(m) : typeof m;
    for (const k of ['DB_PATH', 'dbPath', 'DATABASE_PATH', 'getDbPath', 'getDatabasePath', 'resolveDbPath']) {
      const v = m && m[k];
      if (typeof v === 'string') { dbPath = v; break; }
      if (typeof v === 'function') {
        try { const r = v(); if (typeof r === 'string') { dbPath = r; break; } } catch (e) {}
      }
    }
    if (!dbPath && typeof m === 'string') dbPath = m;
  } catch (e) {
    out.dbPathError = String(e.message).split('\n')[0];
  }
  if (!dbPath || !fs.existsSync(dbPath)) dbPath = candidates.find(c => fs.existsSync(c)) || null;
  out.dbPath = dbPath;
  if (!dbPath) throw new Error('no database file found');

  const Database = require(require.resolve('better-sqlite3', { paths: [root] }));
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  out.sizeBytes = fs.statSync(dbPath).size;

  const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map(r => r.name);
  out.tables = {};
  for (const t of tables) {
    try { out.tables[t] = db.prepare('select count(*) c from "' + t.replace(/"/g, '""') + '"').get().c; }
    catch (e) { out.tables[t] = 'error'; }
  }

  if (tables.includes('nodes')) {
    out.nodeKinds = db.prepare('select kind, count(*) c from nodes group by kind').all();
    const rows = db.prepare("select file_path, content from nodes where kind='file'").all();
    let same = 0, eolOnly = 0, nullContent = 0;
    const differ = [], missing = [];
    for (const r of rows) {
      const rel = String(r.file_path || '').replace(/\\/g, '/');
      const abs = path.isAbsolute(r.file_path) ? r.file_path : path.join(root, r.file_path);
      if (!fs.existsSync(abs)) { missing.push(rel); continue; }
      if (r.content == null) { nullContent++; continue; }
      const disk = fs.readFileSync(abs, 'utf8');
      const idx = String(r.content);
      if (disk === idx) same++;
      else if (disk.replace(/\r\n/g, '\n') === idx.replace(/\r\n/g, '\n')) eolOnly++;
      else differ.push(rel);
    }
    out.freshness = { checked: rows.length, same, eolOnly, differ, missing, nullContent };
  }
  if (tables.includes('edges')) {
    out.edgeKinds = db.prepare('select kind, count(*) c from edges group by kind').all();
  }
  db.close();
} catch (e) {
  out.error = String(e.message).split('\n')[0];
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
'@

$dbFile = Join-Path $tmp 'dbprobe.cjs'
$dbOut  = Join-Path $tmp 'dbprobe.json'
Set-Content -LiteralPath $dbFile -Value $dbJs -Encoding UTF8

$dbCandidates = @(Get-ChildItem -LiteralPath $ProjectRoot -Recurse -File -Include *.db,*.sqlite,*.sqlite3 -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\(node_modules|\.git)\\' -and $_.FullName -notmatch 'backup' } |
    ForEach-Object { $_.FullName })

if ($nodeVer) {
    $argsList = @($dbFile, $ProjectRoot, $dbOut) + $dbCandidates
    & node @argsList 2>&1 | Out-Null
    if (Test-Path -LiteralPath $dbOut) {
        $dbr = Get-Content -LiteralPath $dbOut -Raw | ConvertFrom-Json
        if ($dbr.error) {
            Add-Result 'DB' 'open (read-only)' 'FAIL' $dbr.error
        } else {
            Add-Result 'DB' 'open (read-only)' 'PASS' ("{0} ({1:N0} KB)" -f $dbr.dbPath, ($dbr.sizeBytes / 1KB))
            Add-Result 'DB' 'table row counts' 'INFO' (($dbr.tables.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', ')
            if ($dbr.nodeKinds) {
                Add-Result 'DB' 'node kinds' 'INFO' (($dbr.nodeKinds | ForEach-Object { "$($_.kind)=$($_.c)" }) -join ', ')
            }
            if ($dbr.edgeKinds) {
                Add-Result 'DB' 'edge kinds' 'INFO' (($dbr.edgeKinds | ForEach-Object { "$($_.kind)=$($_.c)" }) -join ', ')
            }
            if ($dbr.freshness) {
                $fr = $dbr.freshness
                $detail = "checked=$($fr.checked) same=$($fr.same) eolOnly=$($fr.eolOnly) differ=$(@($fr.differ).Count) missingOnDisk=$(@($fr.missing).Count)"
                if (@($fr.differ).Count -eq 0 -and @($fr.missing).Count -eq 0) {
                    Add-Result 'Index' 'content vs disk' 'PASS' $detail
                } else {
                    Add-Result 'Index' 'content vs disk' 'WARN' $detail
                    foreach ($d in $fr.differ)  { Add-Result 'Index' 'stale file' 'WARN' $d }
                    foreach ($d in $fr.missing) { Add-Result 'Index' 'indexed but missing on disk' 'WARN' $d }
                }
            }
        }
    }
}

# ---------------------------------------------------------------- 5. Tests (optional)
if ($RunTests) {
    Write-Host "`n--- 5. Tests ---" -ForegroundColor Cyan
    $ansi = '\x1B\[[0-9;]*[A-Za-z]'

    $testOut = (& npm test 2>&1 | Out-String) -replace $ansi, ''
    $testExit = $LASTEXITCODE
    $testLog = Join-Path $reportDir "npm-test-$stamp.log"
    Set-Content -LiteralPath $testLog -Value $testOut -Encoding UTF8
    $files = [regex]::Match($testOut, 'Test Files\s+(.+)').Groups[1].Value.Trim()
    $tests = [regex]::Match($testOut, 'Tests\s+(.+)').Groups[1].Value.Trim()
    $detail = "exit=$testExit | files: $files | tests: $tests | log: $testLog"
    if ($testExit -eq 0) { Add-Result 'Tests' 'npm test' 'PASS' $detail } else { Add-Result 'Tests' 'npm test' 'FAIL' $detail }

    $extOut = (& npm run test:extension 2>&1 | Out-String) -replace $ansi, ''
    $extExit = $LASTEXITCODE
    $extLog = Join-Path $reportDir "npm-test-extension-$stamp.log"
    Set-Content -LiteralPath $extLog -Value $extOut -Encoding UTF8
    if ($extExit -eq 0) { Add-Result 'Tests' 'npm run test:extension' 'PASS' "exit=0 | log: $extLog" }
    else { Add-Result 'Tests' 'npm run test:extension' 'FAIL' "exit=$extExit | log: $extLog" }
} else {
    Add-Result 'Tests' 'npm test' 'INFO' 'skipped (use -RunTests)'
}

# ---------------------------------------------------------------- 6. Live API (optional)
if ($LiveApi) {
    Write-Host "`n--- 6. Live API on $BaseUrl ---" -ForegroundColor Cyan

    $endpoints = @(
        @{ Path = '/api/stats';                          Expect = 'ok' },
        @{ Path = '/api/index-status';                   Expect = 'ok' },
        @{ Path = '/api/analytics';                      Expect = 'ok' },
        @{ Path = '/api/verify?name=main';               Expect = 'ok' },
        @{ Path = '/api/search?q=scan';                  Expect = 'ok' },
        @{ Path = '/api/file?path=server.js';            Expect = 'ok' },
        @{ Path = '/api/security';                       Expect = 'ok' },
        @{ Path = '/api/dead-code';                      Expect = 'ok' },
        @{ Path = '/api/blast-radius/symbols';           Expect = 'ok' },
        @{ Path = '/api/blast-radius?file=server.js';    Expect = 'ok' },
        @{ Path = '/api/dependency-audit';               Expect = 'ok' },
        @{ Path = '/api/dependency-graph';               Expect = 'ok' },
        @{ Path = '/api/change-intelligence';            Expect = 'ok' },
        @{ Path = '/api/release-readiness';              Expect = 'ok' },
        @{ Path = '/api/dependency-impact?file=server.js'; Expect = 'ok' },
        @{ Path = '/api/graph';                          Expect = 'ok' },
        @{ Path = '/api/call-graph?file=scanner.js';     Expect = 'ok' },
        @{ Path = '/api/export?format=json';             Expect = 'ok' },
        @{ Path = '/api/export?format=markdown';         Expect = 'ok' },
        @{ Path = '/api/export?format=invalid-format';   Expect = 'client-error' }
    )

    $reachable = $true
    try { $null = Invoke-WebRequest -Uri $BaseUrl -UseBasicParsing -TimeoutSec 5 } catch {
        if (-not $_.Exception.Response) { $reachable = $false }
    }

    if (-not $reachable) {
        Add-Result 'API' 'server' 'FAIL' "no server answering at $BaseUrl - start it with 'npm start' or pass -BaseUrl"
    } else {
        foreach ($ep in $endpoints) {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $code = 0; $body = ''; $err = ''
            try {
                $r = Invoke-WebRequest -Uri ($BaseUrl + $ep.Path) -UseBasicParsing -TimeoutSec 90
                $code = [int]$r.StatusCode
                $body = [string]$r.Content
            } catch {
                $err = Get-FirstLine $_.Exception.Message
                if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
            }
            $sw.Stop()
            $ms = $sw.ElapsedMilliseconds
            $jsonNote = ''
            if ($code -ge 200 -and $code -lt 300 -and $ep.Path -notmatch 'markdown') {
                try { $null = $body | ConvertFrom-Json; $jsonNote = ' json=valid' } catch { $jsonNote = ' json=NOT-JSON' }
            }
            $detail = "HTTP $code in ${ms}ms$jsonNote $err".Trim()

            if ($ep.Expect -eq 'client-error') {
                if ($code -ge 400 -and $code -lt 500) { Add-Result 'API' $ep.Path 'PASS' "$detail (rejected as expected)" }
                else { Add-Result 'API' $ep.Path 'WARN' "$detail (expected a 4xx rejection)" }
            } else {
                if ($code -ge 200 -and $code -lt 300) { Add-Result 'API' $ep.Path 'PASS' $detail }
                elseif ($code -ge 400 -and $code -lt 500) { Add-Result 'API' $ep.Path 'WARN' "$detail (responds, but my guessed query parameters may be wrong)" }
                else { Add-Result 'API' $ep.Path 'FAIL' $detail }
            }
        }
    }
} else {
    Add-Result 'API' 'live endpoints' 'INFO' 'skipped (start the server, then use -LiveApi)'
}

# ---------------------------------------------------------------- 7. Report
Write-Host "`n--- Summary ---" -ForegroundColor Cyan
$pass = @($results | Where-Object Status -eq 'PASS').Count
$warn = @($results | Where-Object Status -eq 'WARN').Count
$fail = @($results | Where-Object Status -eq 'FAIL').Count
$info = @($results | Where-Object Status -eq 'INFO').Count
Write-Host ("PASS={0}  WARN={1}  FAIL={2}  INFO={3}" -f $pass, $warn, $fail, $info) -ForegroundColor White

$jsonPath = Join-Path $reportDir "capability-report-$stamp.json"
$mdPath   = Join-Path $reportDir "capability-report-$stamp.md"
$results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$md = New-Object System.Collections.Generic.List[string]
$md.Add("# Cortex capability report")
$md.Add("")
$md.Add("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  |  Root: $ProjectRoot")
$md.Add("PASS=$pass  WARN=$warn  FAIL=$fail  INFO=$info")
$md.Add("")
$md.Add("| Status | Area | Check | Detail |")
$md.Add("|---|---|---|---|")
foreach ($r in $results) {
    $d = ([string]$r.Detail) -replace '\|', '/'
    $md.Add("| $($r.Status) | $($r.Area) | $($r.Check) | $d |")
}
$md | Set-Content -LiteralPath $mdPath -Encoding UTF8

Write-Host "Report: $mdPath" -ForegroundColor Cyan
Write-Host "Report: $jsonPath" -ForegroundColor Cyan

Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($fail -gt 0) { exit 1 } else { exit 0 }
