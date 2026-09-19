<#
.SYNOPSIS
  Creates the organisation's own code-signing certificate for FCM Desktop releases and prints the two
  values to store in Supabase Vault. Run once, on a Windows machine you control, as the owner.

.DESCRIPTION
  Free interim path (owner ruling 2026-09-18: no paid certificate until the system is proven). A stable
  self-signed certificate means every FCM Desktop build is signed by the SAME publisher, so:
    * Windows shows "Iron Eagle Security Ltd" (not "Unknown publisher") in the elevation prompt once the
      public certificate is trusted on a machine;
    * fleet administrators can trust that one certificate (Trusted Publishers / Trusted Root via Intune or
      Group Policy) or write an AppLocker/WDAC publisher rule for it;
    * a tampered installer fails signature verification.
  It does NOT buy Microsoft SmartScreen reputation. Unmanaged machines still see a SmartScreen warning until a
  publicly trusted certificate (Azure Trusted Signing or an OV/EV certificate) replaces this one. Signing runs on
  the protected side (scripts/desktop-signing/sign-and-publish.mjs) with the PFX read from Supabase Vault; GitHub
  only builds and never holds the key.

  Outputs (in -OutputDirectory, default the current directory):
    FCM-Desktop-Signing.pfx  private key + certificate, password-protected  -> NEVER commit; store offline
    FCM-Desktop-Signing.cer  public certificate                              -> publish; fleets trust this
    fcm-desktop-signing.secrets.txt  the two Vault values, for pasting into Supabase once, then delete

.PARAMETER Subject
  The publisher name shown to users. Defaults to the legal entity; override only if it changes.

.EXAMPLE
  # Run the saved file (do not paste the script body into the prompt):
  powershell -NoProfile -ExecutionPolicy Bypass -File .\New-FcmSigningCertificate.ps1

.EXAMPLE
  .\New-FcmSigningCertificate.ps1 -Subject 'CN=Iron Eagle Security Ltd, O=Iron Eagle Security Ltd, C=NZ' -OutputDirectory D:\fcm-signing
#>
[CmdletBinding()]
param(
  [string] $Subject = 'CN=Iron Eagle Security Ltd, O=Iron Eagle Security Ltd, C=NZ',
  [string] $OutputDirectory = (Get-Location).Path,
  [int] $ValidYears = 3
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$password = Read-Host -AsSecureString -Prompt 'Choose a password for the PFX (it becomes the Vault secret desktop_signing_pfx_password)'

# -Type CodeSigningCert already sets the Code Signing EKU (1.3.6.1.5.5.7.3.3); adding it again via -TextExtension fails as a duplicate.
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature `
  -NotAfter (Get-Date).AddYears($ValidYears) `
  -CertStoreLocation 'Cert:\CurrentUser\My'

$pfxPath = Join-Path $OutputDirectory 'FCM-Desktop-Signing.pfx'
$cerPath = Join-Path $OutputDirectory 'FCM-Desktop-Signing.cer'
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT | Out-Null

# The private key now lives in the PFX; remove it from this machine's store so the file is the only copy.
Remove-Item -Path ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -DeleteKey -Force

$plain = [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($password))
$base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath))
$secretsPath = Join-Path $OutputDirectory 'fcm-desktop-signing.secrets.txt'
@(
  "# Supabase Vault secrets (Dashboard -> Project Settings -> Vault -> New secret), names exactly as below."
  "# Paste each value, then DELETE this file. Keep FCM-Desktop-Signing.pfx offline (password manager / vault)."
  "desktop_signing_pfx_base64=$base64"
  "desktop_signing_pfx_password=$plain"
) | Out-File -FilePath $secretsPath -Encoding ascii

Write-Host ''
Write-Host "Certificate : $($cert.Subject)"
Write-Host "Thumbprint  : $($cert.Thumbprint)"
Write-Host "Valid until : $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host "PFX (secret): $pfxPath"
Write-Host "CER (public): $cerPath  -> publish next to the installer; fleets add it to Trusted Publishers"
Write-Host "Secrets     : $secretsPath  -> paste into Supabase Vault (two secrets, names as written), then delete"
Write-Host ''
Write-Host 'Trust on one machine (admin PowerShell), for testing the signed installer:'
Write-Host "  Import-Certificate -FilePath '$cerPath' -CertStoreLocation Cert:\LocalMachine\TrustedPublisher"
Write-Host "  Import-Certificate -FilePath '$cerPath' -CertStoreLocation Cert:\LocalMachine\Root"
