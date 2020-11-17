import * as fs from 'async-file'
import { Subject } from 'await-notify'
import * as net from 'net'
import * as path from 'path'
import * as vscode from 'vscode'
import * as rpc from 'vscode-jsonrpc'
import * as vslc from 'vscode-languageclient'
import { onSetLanguageClient } from '../extension'
import * as jlpkgenv from '../jlpkgenv'
import { switchEnvToPath } from '../jlpkgenv'
import * as juliaexepath from '../juliaexepath'
import * as telemetry from '../telemetry'
import { generatePipeName, inferJuliaNumThreads, setContext } from '../utils'
import { VersionedTextDocumentPositionParams } from './misc'
import * as modules from './modules'
import * as plots from './plots'
import { showProfileResult, showProfileResultFile } from './profiler'
import * as results from './results'
import { Frame } from './results'
import * as workspace from './workspace'


let g_context: vscode.ExtensionContext = null
let g_languageClient: vslc.LanguageClient = null

let g_terminal: vscode.Terminal = null

export let g_connection: rpc.MessageConnection = undefined

function startREPLCommand() {
    telemetry.traceEvent('command-startrepl')

    startREPL(false)
}

function is_remote_env(): boolean {
    return typeof vscode.env.remoteName !== 'undefined'
}

function get_editor(): string {
    if (is_remote_env() || process.platform === 'darwin') {
        // code-server:
        if (vscode.env.appName === 'Code - OSS') {
            return `"${path.join(vscode.env.appRoot, '..', '..', 'bin', 'code-server')}"`
        } else {
            const cmd = vscode.env.appName.includes('Insiders') ? 'code-insiders' : 'code'
            return `"${path.join(vscode.env.appRoot, 'bin', cmd)}"`
        }
    }
    else {
        return `"${process.execPath}"`
    }
}

async function startREPL(preserveFocus: boolean, showTerminal: boolean = true) {
    if (g_terminal === null) {
        const pipename = generatePipeName(process.pid.toString(), 'vsc-julia-repl')
        const startupPath = path.join(g_context.extensionPath, 'scripts', 'terminalserver', 'terminalserver.jl')
        function getArgs() {
            const jlarg2 = [startupPath, pipename, telemetry.getCrashReportingPipename()]
            jlarg2.push(`USE_REVISE=${vscode.workspace.getConfiguration('julia').get('useRevise')}`)
            jlarg2.push(`USE_PLOTPANE=${vscode.workspace.getConfiguration('julia').get('usePlotPane')}`)
            jlarg2.push(`DEBUG_MODE=${process.env.DEBUG_MODE}`)
            return jlarg2
        }

        const env = {
            JULIA_EDITOR: get_editor(),
            JULIA_NUM_THREADS: inferJuliaNumThreads()
        }

        const pkgServer: string = vscode.workspace.getConfiguration('julia').get('packageServer')
        if (pkgServer.length !== 0) {
            env['JULIA_PKG_SERVER'] = pkgServer
        }

        const juliaIsConnectedPromise = startREPLMsgServer(pipename)
        const exepath = await juliaexepath.getJuliaExePath()
        const pkgenvpath = await jlpkgenv.getEnvPath()
        if (pkgenvpath === null) {
            const jlarg1 = ['-i', '--banner=no'].concat(vscode.workspace.getConfiguration('julia').get('additionalArgs'))
            g_terminal = vscode.window.createTerminal(
                {
                    name: 'Julia REPL',
                    shellPath: exepath,
                    shellArgs: jlarg1.concat(getArgs()),
                    env: env
                })
        }
        else {
            const env_file_paths = await jlpkgenv.getProjectFilePaths(pkgenvpath)

            let sysImageArgs = []
            if (vscode.workspace.getConfiguration('julia').get('useCustomSysimage') && env_file_paths.sysimage_path && env_file_paths.project_toml_path && env_file_paths.manifest_toml_path) {
                const date_sysimage = await fs.stat(env_file_paths.sysimage_path)
                const date_manifest = await fs.stat(env_file_paths.manifest_toml_path)

                if (date_sysimage.mtime > date_manifest.mtime) {
                    sysImageArgs = ['-J', env_file_paths.sysimage_path]
                }
                else {
                    vscode.window.showWarningMessage('Julia sysimage for this environment is out-of-date and not used for REPL.')
                }
            }
            const jlarg1 = ['-i', '--banner=no', `--project=${pkgenvpath}`].concat(sysImageArgs).concat(vscode.workspace.getConfiguration('julia').get('additionalArgs'))
            g_terminal = vscode.window.createTerminal(
                {
                    name: 'Julia REPL',
                    shellPath: exepath,
                    shellArgs: jlarg1.concat(getArgs()),
                    env: env
                })
        }
        g_terminal.show(preserveFocus)
        await juliaIsConnectedPromise.wait()
    }
    else if (showTerminal) {
        g_terminal.show(preserveFocus)
    }
}

function killREPL() {
    if (g_terminal) {
        g_terminal.dispose()
    }
}

function debuggerRun(code: string) {
    const x = {
        type: 'julia',
        request: 'attach',
        name: 'Julia REPL',
        code: code,
        stopOnEntry: false
    }
    vscode.debug.startDebugging(undefined, x)
}

function debuggerEnter(code: string) {
    const x = {
        type: 'julia',
        request: 'attach',
        name: 'Julia REPL',
        code: code,
        stopOnEntry: true
    }
    vscode.debug.startDebugging(undefined, x)
}

interface ReturnResult {
    inline: string,
    all: string,
    stackframe: null | Array<Frame>
}

const requestTypeReplRunCode = new rpc.RequestType<{
    filename: string,
    line: number,
    column: number,
    code: string,
    mod: string,
    showCodeInREPL: boolean,
    showResultInREPL: boolean,
    softscope: boolean
}, ReturnResult, void, void>('repl/runcode')

const notifyTypeDisplay = new rpc.NotificationType<{ kind: string, data: any }, void>('display')
const notifyTypeDebuggerEnter = new rpc.NotificationType<string, void>('debugger/enter')
const notifyTypeDebuggerRun = new rpc.NotificationType<string, void>('debugger/run')
const notifyTypeReplStartDebugger = new rpc.NotificationType<string, void>('repl/startdebugger')
const notifyTypeReplStartEval = new rpc.NotificationType<void, void>('repl/starteval')
export const notifyTypeReplFinishEval = new rpc.NotificationType<void, void>('repl/finisheval')
export const notifyTypeReplShowInGrid = new rpc.NotificationType<string, void>('repl/showingrid')
const notifyTypeShowProfilerResult = new rpc.NotificationType<string, void>('repl/showprofileresult')
const notifyTypeShowProfilerResultFile = new rpc.NotificationType<string, void>('repl/showprofileresult_file')

interface Progress {
    id: { value: number },
    name: string,
    fraction: number,
    done: Boolean
}
const notifyTypeProgress = new rpc.NotificationType<Progress, void>('repl/updateProgress')

const g_onInit = new vscode.EventEmitter<rpc.MessageConnection>()
export const onInit = g_onInit.event
const g_onExit = new vscode.EventEmitter<Boolean>()
export const onExit = g_onExit.event
const g_onStartEval = new vscode.EventEmitter<null>()
export const onStartEval = g_onStartEval.event
const g_onFinishEval = new vscode.EventEmitter<null>()
export const onFinishEval = g_onFinishEval.event

// code execution start

function startREPLMsgServer(pipename: string) {
    const connected = new Subject()

    const server = net.createServer((socket: net.Socket) => {
        socket.on('close', hadError => {
            g_onExit.fire(hadError)
            server.close()
        })

        g_connection = rpc.createMessageConnection(
            new rpc.StreamMessageReader(socket),
            new rpc.StreamMessageWriter(socket)
        )

        g_connection.listen()

        g_onInit.fire(g_connection)

        connected.notify()
    })

    server.listen(pipename)

    return connected
}

const g_progress_dict = {}

async function updateProgress(progress: Progress) {
    if (g_progress_dict[progress.id.value]) {
        const p = g_progress_dict[progress.id.value]
        const increment = progress.done ? 100 : (progress.fraction - p.last_fraction) * 100

        p.progress.report({
            increment: increment,
            message: progressMessage(progress)
        })
        p.last_fraction = progress.fraction

        if (progress.done) {
            p.resolve()
            delete g_progress_dict[progress.id.value]
        }
    } else {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: 'Julia',
            cancellable: true
        }, (prog, token) => {
            return new Promise(resolve => {
                g_progress_dict[progress.id.value] = {
                    progress: prog,
                    last_fraction: progress.fraction,
                    resolve: resolve,
                }
                token.onCancellationRequested(ev => {
                    interrupt()
                })
                prog.report({
                    message: progressMessage(progress)
                })
            })
        })
    }
}

function progressMessage(prog: Progress) {
    let message = prog.name
    if (!isNaN(prog.fraction) && 0 <= prog.fraction && prog.fraction <= 1) {
        message += ` (${(prog.fraction * 100).toFixed(1)}%)`
    }
    return message
}

function clearProgress() {
    for (const id in g_progress_dict) {
        g_progress_dict[id].resolve()
        delete g_progress_dict[id]
    }
}

async function executeFile(uri?: vscode.Uri) {
    telemetry.traceEvent('command-executeFile')

    const editor = vscode.window.activeTextEditor

    await startREPL(true, false)

    let module = 'Main'
    let path = ''
    let code = ''
    if (uri) {
        path = uri.fsPath
        const readBytes = await vscode.workspace.fs.readFile(uri)
        code = Buffer.from(readBytes).toString('utf8')
    }
    else {
        if (!editor) {
            return
        }
        path = editor.document.fileName
        code = editor.document.getText()

        const pos = editor.document.validatePosition(new vscode.Position(0, 1)) // xref: https://github.com/julia-vscode/julia-vscode/issues/1500
        module = await modules.getModuleForEditor(editor.document, pos)
    }

    await g_connection.sendRequest(
        requestTypeReplRunCode,
        {
            filename: path,
            line: 0,
            column: 0,
            mod: module,
            code: code,
            showCodeInREPL: false,
            showResultInREPL: true,
            softscope: false
        }
    )
}

async function getBlockRange(params): Promise<vscode.Position[]> {
    const zeroPos = new vscode.Position(0, 0)
    const zeroReturn = [zeroPos, zeroPos, params.position]

    if (g_languageClient === null) {
        vscode.window.showErrorMessage('No LS running or start. Check your settings.')
        return zeroReturn
    }

    await g_languageClient.onReady()

    let ret_val: vscode.Position[]
    try {
        ret_val = await g_languageClient.sendRequest('julia/getCurrentBlockRange', params)
    } catch (err) {
        if (err.message === 'Language client is not ready yet') {
            vscode.window.showErrorMessage(err)
            return zeroReturn
        } else {
            console.error(err)
            throw err
        }
    }

    return ret_val
}

async function selectJuliaBlock() {
    telemetry.traceEvent('command-selectCodeBlock')

    const editor = vscode.window.activeTextEditor
    const params: VersionedTextDocumentPositionParams = {
        textDocument: vslc.TextDocumentIdentifier.create(editor.document.uri.toString()),
        version: editor.document.version,
        position: editor.document.validatePosition(new vscode.Position(editor.selection.start.line, editor.selection.start.character))
    }

    const ret_val: vscode.Position[] = await getBlockRange(params)

    const start_pos = editor.document.validatePosition(new vscode.Position(ret_val[0].line, ret_val[0].character))
    const end_pos = editor.document.validatePosition(new vscode.Position(ret_val[1].line, ret_val[1].character))
    vscode.window.activeTextEditor.selection = new vscode.Selection(start_pos, end_pos)
    vscode.window.activeTextEditor.revealRange(new vscode.Range(start_pos, end_pos))
}

const g_cellDelimiters = [
    /^##(?!#)/,
    /^#(\s?)%%/
]

function isCellBorder(s: string) {
    return g_cellDelimiters.some(regex => regex.test(s))
}

async function executeCell(shouldMove: boolean = false) {
    telemetry.traceEvent('command-executeCell')

    const ed = vscode.window.activeTextEditor
    const doc = ed.document
    const curr = doc.validatePosition(ed.selection.active).line
    let start = curr
    while (start >= 0) {
        if (isCellBorder(doc.lineAt(start).text)) {
            break
        } else {
            start -= 1
        }
    }
    start += 1
    let end = start
    while (end < doc.lineCount) {
        if (isCellBorder(doc.lineAt(end).text)) {
            break
        } else {
            end += 1
        }
    }
    end -= 1
    const startpos = ed.document.validatePosition(new vscode.Position(start, 0))
    const endpos = ed.document.validatePosition(new vscode.Position(end, doc.lineAt(end).text.length))
    const nextpos = ed.document.validatePosition(new vscode.Position(end + 1, 0))
    const code = doc.getText(new vscode.Range(startpos, endpos))

    const module: string = await modules.getModuleForEditor(ed.document, startpos)

    await startREPL(true, false)

    if (shouldMove) {
        vscode.window.activeTextEditor.selection = new vscode.Selection(nextpos, nextpos)
        vscode.window.activeTextEditor.revealRange(new vscode.Range(nextpos, nextpos))
    }

    await evaluate(ed, new vscode.Range(startpos, endpos), code, module)
}

async function evaluateBlockOrSelection(shouldMove: boolean = false) {
    telemetry.traceEvent('command-executeCodeBlockOrSelection')


    const editor = vscode.window.activeTextEditor
    const editorId = vslc.TextDocumentIdentifier.create(editor.document.uri.toString())
    const selections = editor.selections.slice()

    await startREPL(true, false)

    for (const selection of selections) {
        let range: vscode.Range = null
        let nextBlock: vscode.Position = null
        const startpos: vscode.Position = editor.document.validatePosition(new vscode.Position(selection.start.line, selection.start.character))
        const params: VersionedTextDocumentPositionParams = {
            textDocument: editorId,
            version: editor.document.version,
            position: startpos
        }

        const module: string = await modules.getModuleForEditor(editor.document, startpos)

        if (selection.isEmpty) {
            const currentBlock = await getBlockRange(params)
            range = new vscode.Range(currentBlock[0].line, currentBlock[0].character, currentBlock[1].line, currentBlock[1].character)
            nextBlock = editor.document.validatePosition(new vscode.Position(currentBlock[2].line, currentBlock[2].character))
        } else {
            range = new vscode.Range(selection.start, selection.end)
        }

        const text = editor.document.getText(range)

        if (shouldMove && nextBlock && selection.isEmpty && editor.selections.length === 1) {
            editor.selection = new vscode.Selection(nextBlock, nextBlock)
            editor.revealRange(new vscode.Range(nextBlock, nextBlock))
        }

        if (range.isEmpty) {
            return
        }

        const tempDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.hoverHighlightBackground'),
            isWholeLine: true
        })
        editor.setDecorations(tempDecoration, [range])

        setTimeout(() => {
            editor.setDecorations(tempDecoration, [])
        }, 200)

        await evaluate(editor, range, text, module)
    }
}

async function evaluate(editor: vscode.TextEditor, range: vscode.Range, text: string, module: string) {
    telemetry.traceEvent('command-evaluate')

    const section = vscode.workspace.getConfiguration('julia')
    const resultType: string = section.get('execution.resultType')
    const codeInREPL: boolean = section.get('execution.codeInREPL')

    let r: results.Result = null
    if (resultType !== 'REPL') {
        r = results.addResult(editor, range, ' ⟳ ', '')
    }

    const result: ReturnResult = await g_connection.sendRequest(
        requestTypeReplRunCode,
        {
            filename: editor.document.fileName,
            line: range.start.line,
            column: range.start.character,
            code: text,
            mod: module,
            showCodeInREPL: codeInREPL,
            showResultInREPL: resultType !== 'inline',
            softscope: true
        }
    )

    if (resultType !== 'REPL') {
        if (result.stackframe) {
            results.clearStackTrace()
            results.setStackTrace(r, result.all, result.stackframe)
        }
        r.setContent(results.resultContent(' ' + result.inline + ' ', result.all, Boolean(result.stackframe)))
    }
}

async function executeCodeCopyPaste(text: string, individualLine: boolean) {
    if (!text.endsWith('\n')) {
        text = text + '\n'
    }

    await startREPL(true, true)

    let lines = text.split(/\r?\n/)
    lines = lines.filter(line => line !== '')
    text = lines.join('\n')
    if (individualLine || process.platform === 'win32') {
        g_terminal.sendText(text + '\n', false)
    }
    else {
        g_terminal.sendText('\u001B[200~' + text + '\n' + '\u001B[201~', false)
    }
}

function executeSelectionCopyPaste() {
    telemetry.traceEvent('command-executeSelectionCopyPaste')

    const editor = vscode.window.activeTextEditor
    if (!editor) {
        return
    }

    const selection = editor.selection

    const text = selection.isEmpty ? editor.document.lineAt(selection.start.line).text : editor.document.getText(selection)

    // If no text was selected, try to move the cursor to the end of the next line
    if (selection.isEmpty) {
        for (let line = selection.start.line + 1; line < editor.document.lineCount; line++) {
            if (!editor.document.lineAt(line).isEmptyOrWhitespace) {
                const newPos = selection.active.with(line, editor.document.lineAt(line).range.end.character)
                const newSel = new vscode.Selection(newPos, newPos)
                editor.selection = newSel
                break
            }
        }
    }
    executeCodeCopyPaste(text, selection.isEmpty)
}

const interrupts = []
let last_interrupt_index = -1
function interrupt() {
    telemetry.traceEvent('command-interrupt')
    // always send out internal interrupt
    softInterrupt()
    // but we'll try sending a SIGINT if more than 3 interrupts were sent in the last second
    last_interrupt_index = (last_interrupt_index + 1) % 5
    interrupts[last_interrupt_index] = new Date()
    const now = new Date()
    if (interrupts.filter(x => (now.getTime() - x.getTime()) < 1000).length >= 3) {
        signalInterrupt()
    }
}

function softInterrupt() {
    try {
        g_connection.sendNotification('repl/interrupt')
    } catch (err) {
        console.warn(err)
    }
}

function signalInterrupt() {
    telemetry.traceEvent('command-signal-interrupt')
    try {
        if (process.platform !== 'win32') {
            g_terminal.processId.then(pid => process.kill(pid, 'SIGINT'))
        } else {
            console.warn('Signal interrupts are not supported on Windows.')
        }
    } catch (err) {
        console.warn(err)
    }
}

// code execution end

async function cdToHere(uri: vscode.Uri) {
    telemetry.traceEvent('command-cdHere')

    const uriPath = await getDirUriFsPath(uri)
    await startREPL(true, false)
    if (uriPath) {
        try {
            g_connection.sendNotification('repl/cd', uriPath)
        } catch (err) {
            console.log(err)
        }
    }
}

async function activateHere(uri: vscode.Uri) {
    telemetry.traceEvent('command-activateThisEnvironment')

    const uriPath = await getDirUriFsPath(uri)
    await startREPL(true, false)
    if (uriPath) {
        try {
            g_connection.sendNotification('repl/activateProject', uriPath)
            switchEnvToPath(uriPath, true)
        } catch (err) {
            console.log(err)
        }
    }
}

async function activateFromDir(uri: vscode.Uri) {
    const uriPath = await getDirUriFsPath(uri)
    await startREPL(true, false)
    if (uriPath) {
        try {
            const activeDir = await g_connection.sendRequest<string | undefined>('repl/activateProjectFromDir', uriPath)
            if (!activeDir) {
                vscode.window.showWarningMessage(`No project file found for ${uriPath}`)
                return
            }
            switchEnvToPath(activeDir, true)
        } catch (err) {
            console.log(err)
        }
    }
}

async function getDirUriFsPath(uri: vscode.Uri | undefined) {
    if (!uri) {
        const ed = vscode.window.activeTextEditor
        if (ed && ed.document && ed.document.uri) {
            uri = ed.document.uri
        }
    }
    if (!uri || !uri.fsPath) {
        return undefined
    }

    const uriPath = uri.fsPath
    const stat = await fs.stat(uriPath)
    if (stat.isFile()) {
        return path.dirname(uriPath)
    } else if (stat.isDirectory()) {
        return uriPath
    } else {
        return undefined
    }
}

export async function replStartDebugger(pipename: string) {
    await startREPL(true)

    g_connection.sendNotification(notifyTypeReplStartDebugger, pipename)
}

export function activate(context: vscode.ExtensionContext) {
    g_context = context

    context.subscriptions.push(
        // listeners
        onSetLanguageClient(languageClient => {
            g_languageClient = languageClient
        }),
        onInit(connection => {
            connection.onNotification(notifyTypeDisplay, plots.displayPlot)
            connection.onNotification(notifyTypeDebuggerRun, debuggerRun)
            connection.onNotification(notifyTypeDebuggerEnter, debuggerEnter)
            connection.onNotification(notifyTypeReplStartEval, () => g_onStartEval.fire(null))
            connection.onNotification(notifyTypeReplFinishEval, () => g_onFinishEval.fire(null))
            connection.onNotification(notifyTypeShowProfilerResult, showProfileResult)
            connection.onNotification(notifyTypeShowProfilerResultFile, showProfileResultFile)
            connection.onNotification(notifyTypeProgress, updateProgress)
            setContext('isJuliaEvaluating', false)
        }),
        onExit(() => {
            results.removeAll()
            setContext('isJuliaEvaluating', false)
        }),
        onStartEval(() => {
            updateProgress({
                name: 'Evaluating…',
                id: { value: -1 },
                fraction: -1,
                done: false
            })
            setContext('isJuliaEvaluating', true)
        }),
        onFinishEval(() => {
            clearProgress()
            setContext('isJuliaEvaluating', false)
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('julia.usePlotPane')) {
                try {
                    g_connection.sendNotification('repl/togglePlotPane', vscode.workspace.getConfiguration('julia').get('usePlotPane'))
                } catch (err) {
                    console.warn(err)
                }
            }
        }),
        vscode.window.onDidChangeActiveTerminal(terminal => {
            if (terminal === g_terminal) {
                setContext('isJuliaREPL', true)
            } else {
                setContext('isJuliaREPL', false)
            }
        }),
        vscode.window.onDidCloseTerminal(terminal => {
            if (terminal === g_terminal) {
                g_terminal = null
            }
        }),
        // commands
        vscode.commands.registerCommand('language-julia.startREPL', startREPLCommand),
        vscode.commands.registerCommand('language-julia.stopREPL', killREPL),
        vscode.commands.registerCommand('language-julia.selectBlock', selectJuliaBlock),
        vscode.commands.registerCommand('language-julia.executeCodeBlockOrSelection', evaluateBlockOrSelection),
        vscode.commands.registerCommand('language-julia.executeCodeBlockOrSelectionAndMove', () => evaluateBlockOrSelection(true)),
        vscode.commands.registerCommand('language-julia.executeCell', executeCell),
        vscode.commands.registerCommand('language-julia.executeCellAndMove', () => executeCell(true)),
        vscode.commands.registerCommand('language-julia.executeFile', executeFile),
        vscode.commands.registerCommand('language-julia.interrupt', interrupt),
        vscode.commands.registerCommand('language-julia.executeJuliaCodeInREPL', executeSelectionCopyPaste), // copy-paste selection into REPL. doesn't require LS to be started
        vscode.commands.registerCommand('language-julia.cdHere', cdToHere),
        vscode.commands.registerCommand('language-julia.activateHere', activateHere),
        vscode.commands.registerCommand('language-julia.activateFromDir', activateFromDir),
    )

    const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated')
    const shellSkipCommands: Array<String> = terminalConfig.get('commandsToSkipShell')
    if (shellSkipCommands.indexOf('language-julia.interrupt') === -1) {
        shellSkipCommands.push('language-julia.interrupt')
        terminalConfig.update('commandsToSkipShell', shellSkipCommands, true)
    }

    results.activate(context)
    plots.activate(context)
    workspace.activate(context)
    modules.activate(context)
}
