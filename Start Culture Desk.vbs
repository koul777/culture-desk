Option Explicit
Dim shell, fso, root, node, code
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
node = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(node) Then
  MsgBox "Node.js 24.14 or newer is required.", 16, "Culture Desk"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
code = shell.Run("""" & node & """ """ & root & "\scripts\launcher.mjs""", 0, True)
If code <> 0 Then MsgBox "Start failed. See logs\launcher-error.txt.", 16, "Culture Desk"
