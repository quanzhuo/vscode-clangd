## v0.5.0

Improvements:

* Bundled the latest clangd language server 22.0 (linux-x64, linux-arm64, win32-x64)
* No longer depends on redhat.vscode-yaml extension
* Renamed `clangd.useBuiltInClangdIfAvailable` to `clangd.preferBundledClangd`

## v0.4.0

Improvements:

* Bundled the latest clangd language server (linux-x64, linux-arm64, win32-x64)
* Conditionally initialize QMakeTools
* Fixed prompt message when clangd path is empty
* Removed client-side semantic highlighting implementation
* Added setting `clangd.useBuiltInClangdIfAvailable` to control whether to use the bundled clangd language server

## v0.3.1

Improvements:

* Attempt to get compile database directory from the `KylinIdeTeam.qmake-tools` extension
* Synced updates with vscode-clangd 0.1.34

Bug Fixes:

* Fixed showAST string error

## v0.3.0

* Get compile database directory from CMake Tools

## v0.2.25

* Synced updates from upstream
* Updated .clang-format configuration to follow LLVM format specification
* Changed extension name in openvsx marketplace to kylin-debug to match vscode marketplace

## v0.2.24

* Use compile_flags.txt when clangd version is lower than 11

## v0.2.23

* Added redhat.vscode-yaml extension dependency for configuration file auto-completion and validation
* Disabled shell option when starting clangd

## v0.2.22

* Added command to create .clangd, .clang-tidy, .clang-format files in workspace

## v0.2.21

* Internationalization no longer references the deprecated process.env.VSCODE_NLS_CONFIG
* Removed Compiler configuration from .clangd file
* Extension no longer creates .clangd, .clang-tidy, .clang-format files by default on activation
* Added monitoring of .clangd and .clang-tidy file changes, and prompt to restart clangd server when modified
* Allow "clangd.path" to point to a shell script
* Specified .clangd, .clang-format and .clang-tidy files as yaml format in package.json

## v0.2.20

* Set language mode to yaml when opening .clangd, .clang-tidy, .clang-format files
* Added yaml schema validation support for .clangd, .clang-tidy, .clang-format files to enable auto-completion when editing these files
* Added redhat.vscode-yaml extension dependency for configuration file auto-completion and validation
* Added configuration option to control whether to create .clangd, .clang-tidy, .clang-format files on extension activation
* Deprecated setting `clangd.additionalIncludePaths`

## v0.2.19

* Changed category of all clangd commands to Kylin Clangd
* Fixed possible crash caused by fs.statSync
* Updated some translation strings

## v0.2.18

* Added .clangd, .clang-tidy files to workspace

## v0.2.17

* Integrated upstream updates
* Updated license and added ThirdPartyNotices.txt file
* Renamed output channel to Kylin Clangd
* Renamed onConfigChanged option in settings to the more appropriate onCompileDatabaseChanged
* Fixed type error in config.ts

## 0.2.14

* Fixed issue where shift+f1 shortcut doesn't work on first use
* Added includeInsertion configuration option to control automatic header file inclusion

## 0.2.13

* Moved Shift + F1 functionality from Qt Support extension to this extension

## 0.2.12

* Added symbolInfo command that can return symbol information at cursor position
* Fixed extension activation failure when clangd path contains spaces
* Don't ignore LICENSE file when packaging

## 0.2.10

* Removed unnecessary files
* When clangd configuration file exists in workspace, use it directly without prompting

## 0.2.8

* Added Chinese description in readme

## 0.2.7

* Fixed shift-f1 jump prompt to install extension entry

## 0.2.6

* Added symbol location functionality to assist in implementing shift-f1 help documentation jump feature

## 0.2.5

* Changed displayName, readme and other information

## 0.2.4

* Fixed clangd not installed prompt

## 0.2.3

* Modified depends.json file

## 0.2.2

* Added default -fPIC setting to make library code position independent
* Modified depends.json file
* Added clangd version detection and warning when version is lower than 9


## 0.2.1

* Added semantic highlighting
* Added Qt header file paths to support Qt completion
* Added other header file paths to support other header file completion
* Fixed dependency installation entry

## 0.1.0

* Based on changes from llvm-vs-code-extensions.vscode-clangd extension commit log: c0375489682e331ad06c25b60df86e4f102a6407 (one commit higher than 0.1.23: modify CHANGELOG.md)
* Added localization language and modified dependency prompts
* Added depends.json file for extension dependency management
* Added domestic download link for extension
