#!/usr/bin/env pwsh
<#
.SYNOPSIS
  dsh-claude-mem 一键回滚：把 profile 恢复成「meow 阵营启用 / dsh-claude-mem 关闭」。

.DESCRIPTION
  回滚不是「删代码」，而是「改回启停状态」——两份数据目录互不影响，回滚不删任何数据（PLAN.md §9）。

  三种模式：
    -Profile 名字        改真实 profile 的 cordis.patch.yml（先备份、再改；默认不重启）
    -ProfileDir 路径     改任意目录下的 cordis.patch.yml（演练/测试用，不重启）
    -Patch 占位          只输出「回滚应改成的补丁片段」到 stdout（dry-run 用，不改任何文件）

  安全约定（用户要求）：
    1. 改任何 profile 配置前，先备份成 cordis.patch.yml.bak-rollback-时间戳，并把备份路径打印出来；
    2. 默认**不重启** DSH（重启是用户的动作）；要重启显式加 -Restart；
    3. 幂等：重复跑结果一致；已经回滚过也不会重复追加条目（用显式块标记整块替换）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\rollback.ps1 -ProfileDir C:\path\to\profile -WhatIf
  powershell -ExecutionPolicy Bypass -File tools\rollback.ps1 -ProfileDir C:\path\to\profile
  powershell -ExecutionPolicy Bypass -File tools\rollback.ps1 -Profile desktop -Restart
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string] $Profile,
  [string] $ProfileDir,
  [string] $Patch,
  [string] $MeowBundle,
  [switch] $Restart
)

$ErrorActionPreference = 'Stop'
$Self = 'dsh-claude-mem'
$MeowCandidates = @('dsh-meow-mem', 'meow-memory')

function Write-Step($text) { Write-Host "==> $text" }

# ---------- 模式 C：只打印补丁片段（dry-run，不碰文件） ----------
function Get-RollbackPatch([string] $meowName) {
  return @"
# dsh-claude-mem 回滚补丁片段（追加到 profile 的 cordis.patch.yml 末尾）
- id: $meowName
  disabled: false
- id: $Self
  disabled: true
"@
}

if ($Patch) {
  if ([string]::IsNullOrWhiteSpace($MeowBundle)) { $MeowBundle = $MeowCandidates[0] }
  Write-Step "dry-run：只输出回滚补丁，不改任何文件（meow=$MeowBundle）"
  Get-RollbackPatch $MeowBundle
  exit 0
}

# ---------- 定位 profile 目录 ----------
if (-not $ProfileDir) {
  if (-not $Profile) {
    Write-Error "必须给 -Profile 名字 或 -ProfileDir 路径，或用 -Patch 走 dry-run"
    exit 2
  }
  $ProfileDir = Join-Path (Join-Path $env:DSH_HOME 'profiles') $Profile
}
if (-not (Test-Path $ProfileDir)) {
  Write-Error "profile 目录不存在：$ProfileDir"
  exit 2
}
$ProfileDir = (Resolve-Path $ProfileDir).Path
$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
Write-Step "profile: $ProfileDir"

if (-not (Test-Path $patchPath)) {
  Write-Error "找不到 $patchPath（回滚只改已存在的 profile 配置，不凭空造）"
  exit 2
}

# ---------- 探测要恢复哪个 meow ----------
$pkgPath = Join-Path $ProfileDir 'package.json'
if ([string]::IsNullOrWhiteSpace($MeowBundle)) {
  $names = @()
  if (Test-Path $pkgPath) {
    try {
      $json = Get-Content $pkgPath -Raw | ConvertFrom-Json
      if ($json.dependencies) { $names = @($json.dependencies.PSObject.Properties.Name) }
    } catch {
      $names = @()
    }
  }
  $found = @($MeowCandidates | Where-Object { $names -contains $_ })
  if ($found.Count -gt 0) { $MeowBundle = $found[0] }
  else { $MeowBundle = $MeowCandidates[0] }
}
Write-Step "回滚目标：启用 $MeowBundle / 关闭 $Self"

# ---------- 先备份（用户要求：改之前那一刻的备份 + 把地址发出来） ----------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $ProfileDir "cordis.patch.yml.bak-rollback-$stamp"
Copy-Item $patchPath $backupPath -Force
Write-Step "已备份：$backupPath"
Write-Host "    恢复原样：Copy-Item '$backupPath' '$patchPath' -Force"

# ---------- 读原文，去掉旧的管理块，再追加 ----------
$original = Get-Content $patchPath -Raw
if ($null -eq $original) { $original = '' }

$begin = '# >>> dsh-claude-mem rollback (managed) >>>'
$end = '# <<< dsh-claude-mem rollback (managed) <<<'

$cleaned = $original
$startIdx = $cleaned.IndexOf($begin)
if ($startIdx -ge 0) {
  $endIdx = $cleaned.IndexOf($end)
  if ($endIdx -gt $startIdx) {
    $cleaned = $cleaned.Remove($startIdx, ($endIdx + $end.Length) - $startIdx)
    $cleaned = $cleaned.TrimEnd() + "`n"
    Write-Step "检测到上一次的回滚块，已替换（幂等）"
  }
}

$block = @"
$begin
- id: $MeowBundle
  disabled: false
- id: $Self
  disabled: true
$end
"@

# 关键：profile 的 patch 层通常是「只有注释 + 空数组 []」。
# 空数组后面直接追加 "- id:" 会被 YAML 解析器拒（end of the stream or a
# separator is expected）——演练时真机就是在这里报的错。
# 所以先把孤立的 [] 行删掉，再追加；非空数组才直接接在后面。
$lines = $cleaned -split "\r?\n"
$kept = @()
foreach ($line in $lines) {
  if ($line.Trim() -eq '[]') { continue }
  $kept += $line
}
$cleaned = ($kept -join "`n")

$next = $cleaned.TrimEnd() + "`n" + $block
if ($PSCmdlet.ShouldProcess($patchPath, "写入回滚补丁（启用 $MeowBundle / 关闭 $Self）")) {
  $utf8Bom = New-Object System.Text.UTF8Encoding($true)
  [System.IO.File]::WriteAllText($patchPath, $next, $utf8Bom)
  Write-Step "已写入：$patchPath"
}

# ---------- 校验：回滚后的补丁状态对不对 ----------
Write-Step "校验 YAML 里两家的 disabled 状态（不启动 DSH）"
$verifyScript = Join-Path $PSScriptRoot '_rollback-verify.mjs'
if (Test-Path $verifyScript) {
  node $verifyScript $patchPath $MeowBundle
  if ($LASTEXITCODE -ne 0) {
    Write-Error "校验未通过：回滚后的补丁状态不对（备份仍在：$backupPath）"
    exit 1
  }
} else {
  Write-Host "    （未找到 _rollback-verify.mjs，跳过静态校验）"
}

# ---------- 可选重启（默认不重启） ----------
if ($Restart) {
  Write-Step "重启 DSH（-Restart 显式要求）"
  Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3
  Start-Process 'E:\Program Files\deepseek harness\DeepSeek Harness.exe'
  Write-Step "已重启 DSH"
} else {
  Write-Step "未重启（默认行为：重启是用户的动作，加 -Restart 才会重启）"
}

Write-Step "回滚完成。撤销本次回滚：Copy-Item '$backupPath' '$patchPath' -Force"
