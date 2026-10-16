Option Explicit
Dim shell, fso, root, node, code
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
node = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
shell.CurrentDirectory = root
code = shell.Run("""" & node & """ """ & root & "\scripts\stop.mjs""", 0, True)
If code <> 0 Then MsgBox "Stop failed. Close the app from its settings.", 16, "Culture Desk"
