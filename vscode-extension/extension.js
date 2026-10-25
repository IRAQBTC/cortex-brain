'use strict';

const vscode = require('vscode');
const http = require('http');
const path = require('path');

function verifyFunction(name) {
    return new Promise((resolve, reject) => {
        const url = new URL('http://127.0.0.1:3000/api/verify');
        url.searchParams.set('type', 'function');
        url.searchParams.set('name', name);

        const request = http.get(url, (response) => {
            let body = '';
            response.setEncoding('utf8');

            response.on('data', chunk => {
                body += chunk;

                if (body.length > 1024 * 1024) {
                    request.destroy(new Error('Cortex response exceeded the 1 MB limit.'));
                }
            });

            response.on('end', () => {
                let parsed;

                try {
                    parsed = JSON.parse(body);
                } catch {
                    reject(new Error('Cortex returned an invalid JSON response.'));
                    return;
                }

                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(
                        parsed.message || `Cortex returned HTTP ${response.statusCode}.`
                    ));
                    return;
                }

                if (!['VERIFIED', 'REFUTED', 'INCONCLUSIVE'].includes(parsed.status)) {
                    reject(new Error('Cortex returned an unsupported verification status.'));
                    return;
                }

                resolve(parsed);
            });

            response.on('error', reject);
        });

        request.setTimeout(5000, () => {
            request.destroy(new Error('Connection to Cortex timed out after 5 seconds.'));
        });

        request.on('error', reject);
    });
}

function isInsideRoot(rootPath, candidatePath) {
    const relative = path.relative(rootPath, candidatePath);
    return relative === '' ||
        (!relative.startsWith('..' + path.sep) &&
         relative !== '..' &&
         !path.isAbsolute(relative));
}

async function openEvidenceLocation(index, match) {
    if (!index || typeof index.rootPath !== 'string' ||
        !match || typeof match.filePath !== 'string') {
        vscode.window.showWarningMessage(
            'Cortex: The response does not contain enough path evidence to open this result.'
        );
        return;
    }

    const rootPath = path.resolve(index.rootPath);
    const targetPath = path.resolve(rootPath, match.filePath);

    if (!isInsideRoot(rootPath, targetPath)) {
        vscode.window.showErrorMessage(
            'Cortex: Refused to open a result outside the indexed project root.'
        );
        return;
    }

    try {
        const document = await vscode.workspace.openTextDocument(
            vscode.Uri.file(targetPath)
        );

        const editor = await vscode.window.showTextDocument(document);
        const lineNumber = Number.isInteger(match.line) && match.line > 0
            ? Math.min(match.line - 1, Math.max(document.lineCount - 1, 0))
            : 0;

        const position = new vscode.Position(lineNumber, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenter
        );
    } catch (error) {
        vscode.window.showErrorMessage(
            `Cortex: Could not open evidence location: ${error.message}`
        );
    }
}

function formatEvidence(match) {
    const line = Number.isInteger(match.line) && match.line > 0
        ? String(match.line)
        : 'not recorded';
    const signature = match.signature || 'No signature recorded';

    return [
        `Symbol: ${match.name}`,
        `Type: ${match.kind}`,
        `File: ${match.filePath}`,
        `Line: ${line}`,
        `Signature: ${signature}`
    ].join('\n');
}

async function showVerificationResult(result) {
    if (result.status === 'REFUTED') {
        const indexTime = result.index && result.index.indexedAt
            ? result.index.indexedAt
            : 'not recorded';

        vscode.window.showWarningMessage(
            `Cortex: Not found in the current index. This does not prove absence from current files. Index time: ${indexTime}.`
        );
        return;
    }

    if (result.status !== 'VERIFIED') {
        vscode.window.showWarningMessage(
            `Cortex: Verification inconclusive. ${result.message || 'No further details available.'}`
        );
        return;
    }

    const matches = Array.isArray(result.matches) && result.matches.length
        ? result.matches
        : (result.data ? [result.data] : []);

    if (matches.length === 0) {
        vscode.window.showWarningMessage(
            'Cortex: The API reported VERIFIED but returned no evidence locations.'
        );
        return;
    }

    const items = matches.map((match, index) => ({
        label: `$(symbol-function) ${match.name}`,
        description: `${match.filePath}:${match.line || '?'}`,
        detail: match.signature || 'Signature not recorded',
        match
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: matches.length > 1
            ? `Cortex found ${result.matchCount || matches.length} indexed locations. Select one to inspect.`
            : 'Cortex evidence found. Select the location to inspect its details.',
        matchOnDescription: true,
        matchOnDetail: true
    });

    if (!selected) return;

    const match = selected.match;
    const index = result.index;

    const indexTime = index && index.indexedAt
        ? index.indexedAt
        : 'not recorded';

    const root = index && index.rootPath
        ? index.rootPath
        : 'not recorded';

    const details = [
        formatEvidence(match),
        '',
        `Indexed root: ${root}`,
        `Index timestamp: ${indexTime}`,
        'Evidence source: Cortex index (not a live source-file re-scan).'
    ].join('\n');

    const action = await vscode.window.showInformationMessage(
        `Cortex VERIFIED: ${match.name} — ${match.filePath}:${match.line || '?'}`,
        { modal: true, detail: details },
        'Open Location'
    );

    if (action === 'Open Location') {
        await openEvidenceLocation(index, match);
    }
}

async function activate(context) {
    const disposable = vscode.commands.registerCommand(
        'cortex.verifyFunction',
        async () => {
            const editor = vscode.window.activeTextEditor;

            if (!editor) {
                vscode.window.showWarningMessage(
                    'Cortex: Open a file and select a function name first.'
                );
                return;
            }

            let name = editor.document.getText(editor.selection).trim();

            if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
                const wordRange = editor.document.getWordRangeAtPosition(
                    editor.selection.active,
                    /[A-Za-z_$][\w$]*/
                );

                name = wordRange
                    ? editor.document.getText(wordRange).trim()
                    : '';
            }

            if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
                name = (await vscode.window.showInputBox({
                    title: 'Cortex — Verify Function',
                    prompt: 'Enter the exact function name to search in the Cortex index',
                    placeHolder: 'e.g. activate',
                    validateInput: value =>
                        /^[A-Za-z_$][\w$]*$/.test(value.trim())
                            ? null
                            : 'Enter one valid JavaScript identifier.'
                }) || '').trim();

                if (!name) return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Cortex: Verifying "${name}"...`,
                cancellable: false
            }, async () => {
                try {
                    const result = await verifyFunction(name);
                    await showVerificationResult(result);
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Cortex verification failed: ${error.message}`
                    );
                }
            });
        }
    );

    context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = { activate, deactivate };