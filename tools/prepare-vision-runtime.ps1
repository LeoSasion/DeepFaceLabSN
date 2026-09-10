[CmdletBinding()]
param([string]$ProjectRoot = '')
$ErrorActionPreference = 'Stop'
# A Node process launched from PowerShell 7 can pass incompatible module paths
# to Windows PowerShell 5.1. Load the running shell's own bundled modules.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -Force
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Archive/Microsoft.PowerShell.Archive.psd1') -Force
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$visionRoot = [IO.Path]::GetFullPath($ProjectRoot)
$cacheRoot = Join-Path $visionRoot '.launcher-install/vision'
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null

function Resolve-VisionPath([string]$Relative) {
    $full = [IO.Path]::GetFullPath((Join-Path $visionRoot $Relative))
    if (-not $full.StartsWith($visionRoot.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Visual dependency path escaped the project'
    }
    return $full
}
function Test-Hash([string]$File, [string]$Sha256) {
    return (Test-Path -LiteralPath $File -PathType Leaf) -and ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -eq $Sha256)
}
function Get-Verified([string]$Name, [string]$Url, [string]$Sha256) {
    $cached = Join-Path $cacheRoot $Name
    if (Test-Hash $cached $Sha256) { return $cached }
    $partial = $cached + '.' + [Guid]::NewGuid().ToString('N') + '.partial'
    Write-Host "Downloading $Name"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $partial
    if (-not (Test-Hash $partial $Sha256)) { throw "SHA-256 mismatch: $Name" }
    Move-Item -LiteralPath $partial -Destination $cached -Force
    return $cached
}
function Install-Verified([string]$Source, [string]$Relative, [string]$Sha256) {
    $target = Resolve-VisionPath $Relative
    if (Test-Hash $target $Sha256) { return }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    $pending = $target + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    Copy-Item -LiteralPath $Source -Destination $pending
    if (-not (Test-Hash $pending $Sha256)) { throw "Copy verification failed: $Relative" }
    if (Test-Path -LiteralPath $target) {
        Move-Item -LiteralPath $target -Destination ($target + '.backup-' + [Guid]::NewGuid().ToString('N'))
    }
    Move-Item -LiteralPath $pending -Destination $target
    Write-Host "Ready: $Relative"
}
$dflRevision = 'e4b7543ffa1d73b26fce1e31852727f658ba490c'
$models = @(
    @{ Name='S3FD.npy'; Hash='b4894ecfba8e6461eb1a69490f76184620c816605238ff0ba3216f1143a06c29' },
    @{ Name='2DFAN.npy'; Hash='ca2dc7f0b2aa146842e6de2119fedff1142188b7cff5ab702564952d6cba4624' }
)
foreach ($model in $models) {
    $source = Resolve-VisionPath ('_internal/DeepFaceLab/facelib/' + $model.Name)
    if (-not (Test-Hash $source $model.Hash)) {
        $source = Get-Verified $model.Name "https://raw.githubusercontent.com/iperov/DeepFaceLab/$dflRevision/facelib/$($model.Name)" $model.Hash
    }
    foreach ($profile in @('DeepFaceLab','DeepFaceLab_old')) {
        Install-Verified $source "_internal/$profile/facelib/$($model.Name)" $model.Hash
    }
}
$sface = '_internal/vision_models/face_recognition_sface_2021dec.onnx'
$sfaceHash = '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79'
Install-Verified (Resolve-VisionPath 'tools/licenses/SFace-Apache-2.0.txt') '_internal/vision_models/SFace-LICENSE.txt' 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
if (-not (Test-Hash (Resolve-VisionPath $sface) $sfaceHash)) {
    $source = Get-Verified 'sface-2021dec.onnx' 'https://media.githubusercontent.com/media/opencv/opencv_zoo/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_recognition_sface/face_recognition_sface_2021dec.onnx' $sfaceHash
    Install-Verified $source $sface $sfaceHash
}
$ffmpegHash = '72a489eccd008c2ec2c0a5856c5c75bc3d8bbfa90166c4566865c246445e6aa3'
$ffprobeHash = '19202b23c0043f15ad1b7bce2344f406fd52bd6efd8f995ce02e7392a1cec52f'
if (-not ((Test-Hash (Resolve-VisionPath '_internal/ffmpeg/ffmpeg.exe') $ffmpegHash) -and
          (Test-Hash (Resolve-VisionPath '_internal/ffmpeg/ffprobe.exe') $ffprobeHash))) {
    $archive = Get-Verified 'ffmpeg-9.0.1-essentials_build.zip' 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-essentials_build.zip' 'fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9'
    $expanded = Join-Path $cacheRoot ('ffmpeg-' + [Guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded
    $distribution = Join-Path $expanded 'ffmpeg-9.0.1-essentials_build'
    Install-Verified (Join-Path $distribution 'bin/ffmpeg.exe') '_internal/ffmpeg/ffmpeg.exe' $ffmpegHash
    Install-Verified (Join-Path $distribution 'bin/ffprobe.exe') '_internal/ffmpeg/ffprobe.exe' $ffprobeHash
    Copy-Item -LiteralPath (Join-Path $distribution 'LICENSE') -Destination (Resolve-VisionPath '_internal/ffmpeg/LICENSE') -Force
}
Write-Host 'Visual dependencies verified: FFmpeg, S3FD, 2DFAN, SFace.'
