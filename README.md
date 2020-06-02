# Julia

[![Build Status](https://dev.azure.com/julia-vscode/julia-vscode/_apis/build/status/julia-vscode.julia-vscode?branchName=master)](https://dev.azure.com/julia-vscode/julia-vscode/_build/latest?definitionId=1&branchName=master)

This [VS Code](https://code.visualstudio.com) extension provides support for the [Julia programming language](http://julialang.org/).

## Getting started

Getting the Julia extension for VS Code to work involves two steps: 1.
Install VS Code and 2. Install the Julia extension.

### Installing Julia/VS Code/the Julia extension
1. install Julia for your platform: https://julialang.org/downloads/
2. install VS Code for your platform: https://code.visualstudio.com/download
At the end of this step you should be able to start VS Code.
3. install the Julia VS Code extension:  
3.1 start VS Code. Inside VS Code, go to the extensions view either by
executing the ``View: Show Extensions`` command (click View->Command Palette...)
or by clicking on the extension icon on the left side of the VS Code
window.

In the extensions view, simply search for the term ``Julia`` in the marketplace
search box, then select the Julia extension and click the install button.
You might have to restart VS Code after this step.

### Configure the Julia extension

If you have installed Julia into a standard location on Mac or Windows, or
if the Julia binary is on your ``PATH``, the Julia VS Code extension should
automatically find your Julia installation and you should not need to
configure anything.

If the extension does not find your Julia installation automatically, or
if you want to use a different Julia installation than the default one,
you can set the ``julia.executablePath`` to point to the Julia executable
that the extension should use. In that case the
extension will always use that version of Julia. To edit your configuration
settings, execute the ``Preferences: Open User Settings`` command (you can
also access it via the menu ``File->Preferences->Settings``), and
then make sure your user settings include the ``julia.executablePath``
setting. The format of the string should follow your platform specific
conventions, and be aware that the backlash ``\`` is the escape character
in JSON, so you need to use ``\\`` as the path separator character on Windows.

## Features

The extension currently provides

* syntax highlighting
* snippets
* [latex snippets](https://github.com/julia-vscode/julia-vscode/wiki/Snippets#latex)
* [Julia specific commands](https://github.com/julia-vscode/julia-vscode/wiki/Commands)
* [integrated Julia REPL](https://github.com/julia-vscode/julia-vscode/wiki/REPL)
* [code completion](https://github.com/julia-vscode/julia-vscode/wiki/IntelliSense)
* [hover help](https://github.com/julia-vscode/julia-vscode/wiki/Information#hover-help)
* [a linter](https://github.com/julia-vscode/julia-vscode/wiki/Information#linter)
* [code navigation](https://github.com/julia-vscode/julia-vscode/wiki/Navigation)
* tasks for running tests, builds, benchmarks and build documentation
* an experimental debugger
* a plot gallery
* a grid viewer for tabular data
* integrated support for Weave.jl

## Documentation

The [documentation](https://github.com/julia-vscode/julia-vscode/wiki)
has sections that describe the features of this extension (including
e.g. keyboard shortcuts).

## Known issues and workarounds

Please visit the [known issues and workarounds](https://github.com/julia-vscode/julia-vscode/wiki/Known-issues-and-workarounds)
for up-to-date information about known issues and solutions for those
problems.

## Data/Telemetry

The Julia extension for Visual Studio Code collects usage data and sends it to the development team to help improve the extension. Read our [privacy policy](https://github.com/julia-vscode/julia-vscode/wiki/Privacy-Policy) to learn more and how to disable any telemetry.
