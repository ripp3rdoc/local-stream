' Launches the Local Stream server with no visible console window.
' Point a "run at login" scheduled task at this file.
' Output is appended to logs\server.log.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
' Project root = the folder above this script's "scripts" folder.
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
If Not fso.FolderExists(root & "\logs") Then fso.CreateFolder(root & "\logs")
sh.Run "cmd /c ""node src\server.js >> logs\server.log 2>&1""", 0, False
