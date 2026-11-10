# The installer's module: three script files that Windows PowerShell loads into one module, so that they share their
# functions and the scripts load them with one Import-Module. The package's version is in the file VERSION.
@{
  ModuleVersion     = '1.0'
  Description       = 'What Install-Rpa.ps1 and Uninstall-Rpa.ps1 decide and do.'
  PowerShellVersion = '5.1'
  NestedModules     = @('RpaInstall.Plan.ps1', 'RpaInstall.SignIn.ps1', 'RpaInstall.Machine.ps1')
  FunctionsToExport = @(
    'Get-RpaInstallPlan'
    'Get-RpaUninstallPlan'
    'New-RpaSecret'
    'Get-RpaAccount'
    'Get-RpaLayout'
    'Test-RpaAdministrator'
    'Get-RpaMachineFacts'
    'Get-RpaUninstallFacts'
    'Invoke-RpaInstallPlan'
    'Invoke-RpaUninstall'
    'Get-RpaUninstallSummary'
  )
  CmdletsToExport   = @()
  VariablesToExport = @()
  AliasesToExport   = @()
}
