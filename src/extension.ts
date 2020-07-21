import * as vscode from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	Executable,
	WorkspaceSymbolRequest
} from 'vscode-languageclient';

import { LanguageServerInstaller } from './languageServerInstaller';
import { runCommand } from './terraformCommand';
import { ClientRequest } from 'http';

let clients: Map<string, LanguageClient> = new Map();

function sortedWorkspaceFolders(): string[] {
	const folders = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.map(folder => {
		let result = folder.uri.toString();
		if (result.charAt(result.length - 1) !== '/') {
			result = result + '/';
		}
		return result;
	}).sort(
		(a, b) => {
			return a.length - b.length;
		}
	) : [];

	return folders;
}

function getOuterMostWorkspaceFolder(folder: vscode.WorkspaceFolder): vscode.WorkspaceFolder {
	let sorted = sortedWorkspaceFolders();
	for (let element of sorted) {
		let uri = folder.uri.toString();
		if (uri.charAt(uri.length - 1) !== '/') {
			uri = uri + '/';
		}
		if (uri.startsWith(element)) {
			return vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(element))!;
		}
	}
	return folder;
}

async function installLs(context: vscode.ExtensionContext, config: vscode.WorkspaceConfiguration): Promise<string> {
	const command: string = config.get("languageServer.pathToBinary");
	if (command) { // Skip install/upgrade if user has set custom binary path
		return command
	}

	const installer = new LanguageServerInstaller;
	const installDir = `${context.extensionPath}/lsp`;

	console.log(`installing language server to ${installDir}`);

	try {
		console.log(`stopping...`);
		await stopLsClients();
		console.log(`installing...`);
		await installer.install(installDir);
		console.log(`installed`);
	} catch (e) {
		console.error(`unable to install language server ${e}`);
		vscode.window.showErrorMessage(e)
		throw e;
	}

	console.log(`language server installed`);

	return `${installDir}/terraform-ls`;
}

function startLsClient(cmd: string, folder: vscode.WorkspaceFolder, config: vscode.WorkspaceConfiguration) {
	console.log(`starting ls client ${cmd} for folder ${folder.name}`);

	const binaryName = cmd.split("/").pop();

	const lsConfig = vscode.workspace.getConfiguration("terraform-ls", folder);
	const serverArgs: string[] = config.get("languageServer.args");

	let serverOptions: ServerOptions;
	let initializationOptions = { rootModulePaths: lsConfig.get("rootModules") };

	const setup = vscode.window.createOutputChannel(binaryName);
	setup.appendLine(`Launching language server: ${cmd} ${serverArgs.join(" ")}`);

	const executable: Executable = {
		command: cmd,
		args: serverArgs,
		options: {}
	}
	serverOptions = {
		run: executable,
		debug: executable
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'terraform' }],
		diagnosticCollectionName: "terraform-ls",
		workspaceFolder: folder,
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher('**/*.tf')
		},
		initializationOptions: initializationOptions,
		outputChannel: setup,
		revealOutputChannelOn: 4 // hide always
	};

	const client = new LanguageClient(
		'terraform-ls',
		'Terraform Language Server',
		serverOptions,
		clientOptions
	);

	client.start();
	clients.set(folder.uri.toString(), client);
}

async function installThenStartLsClients(context: vscode.ExtensionContext, config: vscode.WorkspaceConfiguration) {
	const cmd = await installLs(context, config);

	console.log("starting the LS clients");

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(
			(event: vscode.ConfigurationChangeEvent) => {
				if (!event.affectsConfiguration("terraform") && !event.affectsConfiguration("terraform-ls")) {
					return;
				}

				const reloadMsg = "Reload VSCode window to apply language server changes";
				return vscode.window.showInformationMessage(reloadMsg, "Reload").then((selected) => {
					if (selected === "Reload") {
						return vscode.commands.executeCommand("workbench.action.reloadWindow");
					}
				});
			}
		),
		vscode.workspace.onDidOpenTextDocument(document => didOpenTextDocument(cmd, document, context, config)),
		vscode.workspace.onDidChangeWorkspaceFolders((event) => {
			for (let folder of event.removed) {
				const client = clients.get(folder.uri.toString());
				if (client) {
					clients.delete(folder.uri.toString());
					client.stop();
				}
			}
		})
	);

	vscode.workspace.textDocuments.forEach(document => didOpenTextDocument(cmd, document, context, config));
}

async function stopLsClients() {
	let promises: Thenable<void>[] = [];
	for (let client of clients.values()) {
		promises.push(client.stop());
	}
	clients.clear();
	return Promise.all(promises)
		.then(() => undefined);
}

async function enableLanguageServerCommand(context: vscode.ExtensionContext, config: vscode.WorkspaceConfiguration) {
	try {
		await config.update("languageServer.external", true, vscode.ConfigurationTarget.Global);
		await installThenStartLsClients(context, config);
	} catch (e) {
		await config.update("languageServer.external", false, vscode.ConfigurationTarget.Global);
		throw e;
	}
}

async function disableLanguageServerCommand(config: vscode.WorkspaceConfiguration) {
	try {
		await config.update("languageServer.external", false, vscode.ConfigurationTarget.Global);
		await stopLsClients();
	} catch (e) {
		await vscode.window.showErrorMessage(e)
		throw e;
	}
}

async function didOpenTextDocument(cmd: string, document: vscode.TextDocument, context: vscode.ExtensionContext, config: vscode.WorkspaceConfiguration) {
	console.log(`didOpenTextDocument ${document.uri}`);

	// TODO: handle untitled docs?

	const uri = document.uri;
	let folder = vscode.workspace.getWorkspaceFolder(uri);
	// Files outside a folder can't be handled. This might depend on the language.
	// Single file languages like JSON might handle files outside the workspace folders.
	if (!folder) {
		return;
	}
	// If we have nested workspace folders we only start a server on the outer most workspace folder.
	folder = getOuterMostWorkspaceFolder(folder);

	if (!clients.has(folder.uri.toString())) {
		startLsClient(cmd, folder, config);
	}
}

export function activate(context: vscode.ExtensionContext) {
	const commandOutput = vscode.window.createOutputChannel("Terraform");
	const config = vscode.workspace.getConfiguration("terraform");

	// get rid of pre-2.0.0 settings
	if (config.has('languageServer.enabled')) {
		config.update('languageServer',
			{ "external": true, "args": ["serve"], "enabled": undefined },
			true
		)
	}
	let useLs = config.get("languageServer.external");

	context.subscriptions.push(
		vscode.commands.registerCommand('terraform.enableLanguageServer', () => enableLanguageServerCommand(context, config)),
		vscode.commands.registerCommand('terraform.disableLanguageServer', () => disableLanguageServerCommand(config)),
	);

	if (!useLs) {
		return;
	}

	installThenStartLsClients(context, config);
}

export function deactivate(): Thenable<void> {
	return stopLsClients();
}
