' ---------------------------------------------------------------------------
' desktop/launch.vbs — lance la coque Electron de Sarra sans console Windows.
'
' Utilisé par `start.bat desktop` (ou par un raccourci du bureau).
'   - le processus démarre masqué (0) et non bloquant (False) ;
'   - le journal est écrit dans desktop\tts-host.log et start.log à la racine ;
'   - Electron est lancé avec --no-sandbox, nécessaire dans certains
'     environnements (voir desktop/README.md).
' ---------------------------------------------------------------------------
Option Explicit

Dim fso, shell, desktopDir, rootDir, command, logFile

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

desktopDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(desktopDir)
logFile = rootDir & "\start.log"

shell.CurrentDirectory = rootDir

' Si les dépendances ne sont pas installées, on les installe une fois.
If Not fso.FileExists(desktopDir & "\node_modules\electron\package.json") Then
  command = "cmd /c npm --prefix desktop install >> """ & logFile & """ 2>&1"
  shell.Run command, 0, True
End If

command = "cmd /c npm --prefix desktop start >> """ & logFile & """ 2>&1"

On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then
  MsgBox "Sarra n'a pas pu démarrer." & vbCrLf & vbCrLf & _
         "Vérifiez que Node.js 20+ est installé, puis consultez " & logFile & ".", _
         vbExclamation, "Sarra"
End If
On Error GoTo 0
