import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';

// =============================================================
// 1. Interfaces & Types
// =============================================================
interface PyGreenSenseIssue {
    file: string;
    rule: string;
    message: string;
    lineno: number;
    end_lineno: number;
    severity: string;
}

// =============================================================
// 2. Dependency & Venv Management
// =============================================================
function execShellCommand(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.warn(`[Command Failed]: ${cmd}\n${stderr}`);
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

function getVenvPythonPath(venvPath: string): string {
    return process.platform === 'win32' 
        ? path.join(venvPath, 'Scripts', 'python.exe') 
        : path.join(venvPath, 'bin', 'python');
}

async function getBasePython(): Promise<string> {
    const commands = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
    for (const cmd of commands) {
        try {
            await execShellCommand(`"${cmd}" --version`);
            return cmd;
        } catch (e) {}
    }
    throw new Error("ไม่พบโปรแกรม Python ในระบบ กรุณาติดตั้ง Python ก่อนใช้งาน PyGreenSense");
}

async function setupVirtualEnvironment(context: vscode.ExtensionContext): Promise<string> {
    const venvPath = path.join(context.extensionPath, 'src', 'python_source', '.venv');
    const venvPythonPath = getVenvPythonPath(venvPath);
    const requirementsPath = path.join(context.extensionPath, 'requirements.txt');

    return new Promise((resolve, reject) => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "PyGreenSense: กำลังเตรียม Environment...",
            cancellable: false
        }, async (progress) => {
            try {
                if (!fs.existsSync(venvPath)) {
                    progress.report({ message: "กำลังค้นหา Python และสร้าง Environment (.venv)..." });
                    const basePython = await getBasePython();
                    
                    await execShellCommand(`"${basePython}" -m venv "${venvPath}"`);
                    try { await execShellCommand(`"${venvPythonPath}" -m ensurepip --upgrade`); } catch (e) {}
                    console.log('Venv created successfully at:', venvPath);
                }

                if (fs.existsSync(requirementsPath)) {
                    progress.report({ message: "กำลังติดตั้ง Dependencies..." });
                    await execShellCommand(`"${venvPythonPath}" -m pip install -r "${requirementsPath}"`);
                    console.log('Dependencies installed successfully.');
                } else {
                    vscode.window.showWarningMessage('PyGreenSense: ไม่พบไฟล์ requirements.txt');
                }

                resolve(venvPythonPath); 
            } catch (error) {
                console.error('Setup Venv Error:', error);
                vscode.window.showErrorMessage(`PyGreenSense: ไม่สามารถตั้งค่า Environment ได้`);
                reject(error);
            }
        });
    });
}

// =============================================================
// 3. Extension Activation & Main Logic
// =============================================================
export function activate(context: vscode.ExtensionContext) {
    console.log('PyGreenSense is now active!');

    let disposable = vscode.commands.registerCommand('pygreensense.analyze', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('PyGreenSense: กรุณาเปิดไฟล์ Python ก่อนทำการวิเคราะห์');
            return;
        }

        if (editor.document.languageId !== 'python') {
            vscode.window.showErrorMessage('PyGreenSense: รองรับเฉพาะไฟล์ Python (.py)');
            return;
        }

        const filePath = editor.document.uri.fsPath;

        try {
            const venvPythonPath = await setupVirtualEnvironment(context);
            const workerPath = path.join(context.extensionPath, 'src', 'python_source', 'worker.py');
            await runAnalysis(context, venvPythonPath, workerPath, filePath);
        } catch (error) {
            console.error('Initialization Failed:', error);
        }
    });

    context.subscriptions.push(disposable);
}

// =============================================================
// 4. Run Analysis Process
// =============================================================
async function runAnalysis(context: vscode.ExtensionContext, pythonPath: string, workerPath: string, targetFilePath: string) {
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "PyGreenSense: กำลังวิเคราะห์โค้ด...",
        cancellable: false
    }, async (progress) => {
        return new Promise<void>((resolve, reject) => {
            const pyProcess = cp.spawn(pythonPath, [workerPath, targetFilePath]);

            let outputData = '';
            let errorData = '';

            pyProcess.stdout.on('data', (data) => { outputData += data.toString(); });
            pyProcess.stderr.on('data', (data) => { errorData += data.toString(); });

            pyProcess.on('close', (code) => {
                if (code !== 0) {
                    vscode.window.showErrorMessage('PyGreenSense: เกิดข้อผิดพลาดในการวิเคราะห์ (ดู Debug Console)');
                    console.error('Python Error:', errorData);
                    return reject(new Error(errorData));
                }

                try {
                    const result = JSON.parse(outputData);
                    if (result.status === "success") {
                        showReportWebview(context, result.data);
                        vscode.window.showInformationMessage('PyGreenSense: วิเคราะห์เสร็จสิ้น 🌱');
                        resolve();
                    } else {
                        vscode.window.showErrorMessage(`PyGreenSense Error: ${result.message}`);
                        reject(new Error(result.message));
                    }
                } catch (parseError) {
                    console.error('Failed to parse JSON:', outputData);
                    vscode.window.showErrorMessage('PyGreenSense: อ่านข้อมูลจาก Python ไม่สำเร็จ');
                    reject(parseError);
                }
            });
        });
    });
}

// =============================================================
// 5. UI / Webview Dashboard
// =============================================================
function showReportWebview(context: vscode.ExtensionContext, data: any) {
    const panel = vscode.window.createWebviewPanel(
        'pyGreenSenseReport',
        'PyGreenSense Report 🌍',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );

    const issues = data.issues || [];
    const metrics = data.metrics || {};

    let issuesHtml = `<table><tr><th>Rule</th><th>Line</th><th>Message</th></tr>`;
    if (issues.length > 0) {
        issues.forEach((issue: any) => {
            issuesHtml += `<tr><td><span class="badge warning">${issue.rule}</span></td><td>${issue.lineno}</td><td>${issue.message}</td></tr>`;
        });
    } else {
        issuesHtml += `<tr><td colspan="3">🎉 No code smells found! Great job!</td></tr>`;
    }
    issuesHtml += `</table>`;

    panel.webview.html = getWebviewContent(metrics, issuesHtml, issues.length);
}

function getWebviewContent(metrics: any, issuesHtml: string, totalIssues: number): string {
    const sci_cfp = metrics.sci_per_cfp ? metrics.sci_per_cfp.toExponential(4) : 'N/A';
    const cfp = metrics.cfp !== undefined ? metrics.cfp : 'N/A';
    const energy = metrics.energy_consumed_kWh ? metrics.energy_consumed_kWh.toExponential(4) : 'N/A';
    const duration = metrics.duration_seconds ? metrics.duration_seconds.toFixed(4) : 'N/A';
    const target_file = metrics.target_file ? metrics.target_file.split(/[/\\]/).pop() : 'Unknown File';

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); }
            .container { max-width: 800px; margin: auto; }
            h1, h2 { color: var(--vscode-editor-foreground); border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 5px; }
            .grid-container { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin-bottom: 20px; }
            .metric-card { background: var(--vscode-editor-inactiveSelectionBackground); padding: 15px; border-radius: 8px; border-left: 4px solid #4CAF50;}
            .metric-card.orange { border-left-color: #ff9800; }
            .metric-value { font-size: 1.5em; font-weight: bold; margin: 10px 0; }
            .metric-label { font-size: 0.9em; opacity: 0.8; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            th, td { text-align: left; padding: 10px; border-bottom: 1px solid var(--vscode-widget-border); }
            .badge.warning { background-color: #ff9800; color: #000; padding: 3px 8px; border-radius: 4px; font-weight: bold;}
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🌍 PyGreenSense Dashboard</h1>
            <p>Analysis of: <strong>${target_file}</strong></p>
            
            <h2>🌱 Sustainability Metrics</h2>
            <div class="grid-container">
                <div class="metric-card">
                    <div class="metric-label">Software Carbon Intensity (SCI) per CFP</div>
                    <div class="metric-value">${sci_cfp}</div>
                    <div class="metric-label">gCO2eq / Function Point</div>
                </div>
                <div class="metric-card">
                    <div class="metric-label">COSMIC Function Points (CFP)</div>
                    <div class="metric-value">${cfp}</div>
                    <div class="metric-label">Complexity Score</div>
                </div>
                <div class="metric-card orange">
                    <div class="metric-label">Energy Consumed</div>
                    <div class="metric-value">${energy}</div>
                    <div class="metric-label">kWh</div>
                </div>
                <div class="metric-card orange">
                    <div class="metric-label">Analysis Duration</div>
                    <div class="metric-value">${duration}</div>
                    <div class="metric-label">Seconds</div>
                </div>
            </div>

            <h2>🔍 Code Smells Found (${totalIssues})</h2>
            ${issuesHtml}
        </div>
    </body>
    </html>`;
}
export function deactivate() {}