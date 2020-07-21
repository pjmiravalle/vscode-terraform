import * as vscode from 'vscode';

import cp = require('child_process');
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as semver from 'semver';
import * as yauzl from 'yauzl';

const releasesUrl = "https://releases.hashicorp.com/terraform-ls";

interface Release {
	builds?: any[];
	version: any;
	shasums?: any;
	shasums_signature?: any;
}

function exec(cmd): Promise<string> {
	return new Promise((resolve, reject) => {
		cp.exec(cmd, (err, stdout, stderr) => {
			if (err) {
				return reject(err);
			}
			return resolve(stdout ? stdout : stderr);
		})
	})
}

function httpsRequest(url: string, options: https.RequestOptions): Promise<any> {
	return new Promise((resolve, reject) => {
		const req = https.request(url, options, res => {
			if (res.statusCode !== 200) {
				return reject(res.statusMessage);
			}

			const body = [];
			res.on('data', chunk => {
				body.push(chunk);
			})

			res.on('end', () => {
				try {
					resolve(JSON.parse(Buffer.concat(body).toString()));
				} catch (e) {
					reject(e);
				}
			})
		});

		req.on('error', err => reject(err));
		req.end();
	});
}


async function checkLatest(userAgent: string): Promise<any> {
	const indexUrl = `${releasesUrl}/index.json`;
	const headers = { 'User-Agent': userAgent };

	const releases = await httpsRequest(indexUrl, { headers: headers });
	const currentRelease = Object.keys(releases.versions).sort(semver.rcompare)[0];

	return releases.versions[currentRelease];
}

export class LanguageServerInstaller {
	public async install(directory: string) {
		const extensionVersion = '2.0.0'; // TODO set this programatically
		const versionCmd = `${directory}/terraform-ls --version`;
		const userAgent = `Terraform-VSCode/${extensionVersion} VSCode/${vscode.version}`;

		const latestRelease = await checkLatest(userAgent);

		let installedVersion = "";
		try {
			installedVersion = await exec(versionCmd);
		} catch (e) {
			console.warn(`error executing ls version command: ${e}`);
		}

		if (semver.gt(latestRelease.version, installedVersion, { includePrerelease: true })) {
			const installMsg = `A new language server release is available: ${latestRelease.version}. Install now?`;
			const selected = await vscode.window.showInformationMessage(installMsg, 'Install', 'Cancel');

			if (selected === "Install") {
				return this.installPkg(directory, latestRelease, userAgent);
			}
		} else if (installedVersion !== "") {
			return;
		}

		vscode.window.showErrorMessage('Unable to install terraform-ls');
		throw new Error("unable to install terraform-ls");
	}

	async installPkg(installDir: string, release: Release, userAgent: string) {
		const destination: string = `${installDir}/terraform-ls_v${release.version}.zip`;
		fs.mkdirSync(installDir, { recursive: true }); // create install directory if missing

		let platform = os.platform().toString();
		if (platform === 'win32') {
			platform = 'windows';
		}
		let arch = os.arch();
		switch (arch) {
			case 'x64':
				arch = 'amd64'
				break;
			case 'x32':
				arch = '386'
				break;
		}

		const build = release.builds.find(b => b.os === platform && b.arch === arch);
		const downloadUrl = build.url;
		if (!downloadUrl) {
			// No matching build found
			throw new Error("Install error: no matching terraform-ls binary for platform");
		}
		try {
			await this.removeOldBinary(installDir, platform);
		} catch {
			// ignore missing binary (new install)
		}

		return new Promise<void>((resolve, reject) => {
			vscode.window.withProgress({
				cancellable: true,
				location: vscode.ProgressLocation.Notification,
				title: "Installing terraform-ls"
			}, (progress, token) => {
				token.onCancellationRequested(() => {
					return reject();
				});

				progress.report({ increment: 30 });

				return this.download(downloadUrl, destination, userAgent)
					.then(() => {
						progress.report({ increment: 30 });
						return this.verify(release, destination, build.filename)
							.then(() => {
								progress.report({ increment: 30 });
								return this.unpack(installDir, destination)
							})
					})
			}).then(() => {
				vscode.window.showInformationMessage(`Installed terraform-ls ${release.version}.`, "View Changelog")
					.then((selected) => {
						if (selected === "View Changelog") {
							vscode.env.openExternal(vscode.Uri.parse(`https://github.com/hashicorp/terraform-ls/releases/tag/v${release.version}`));
						}
						return resolve();
					});
			},
				(err) => {
					try {
						fs.unlinkSync(destination);
					} finally {
						return reject(err);
					}
				});
		});
	}

	removeOldBinary(directory: string, platform: string) {
		if (platform === "windows") {
			fs.unlinkSync(`${directory}/terraform-ls.exe`);
		} else {
			fs.unlinkSync(`${directory}/terraform-ls`);
		}
	}

	download(downloadUrl: string, installPath: string, identifier: string): Promise<void> {
		const headers = { 'User-Agent': identifier };
		return new Promise<void>((resolve, reject) => {
			const request = https.request(downloadUrl, { headers: headers }, (response) => {
				if (response.statusCode === 301 || response.statusCode === 302) { // redirect for CDN
					const redirectUrl: string = response.headers.location;
					return resolve(this.download(redirectUrl, installPath, identifier));
				}
				if (response.statusCode !== 200) {
					return reject(response.statusMessage);
				}
				const pkg = fs.createWriteStream(installPath);
				response.pipe(pkg);
				response.on('end', () => {
					return resolve();
				});
			});

			request.on('error', (error) => { return reject(error); });
			request.end();
		});
	}

	verify(release: Release, pkg: string, buildName: string) {
		return new Promise<void>((resolve, reject) => {
			Promise.all([
				this.calculateFileSha256Sum(pkg),
				this.downloadSha256Sum(release, buildName)
			]).then((values) => {
				const localSum = values[0];
				const remoteSum = values[1];

				if (remoteSum !== localSum) {
					return reject(`Install error: SHA sum for ${buildName} does not match.\n` +
						`(expected: ${remoteSum} calculated: ${localSum})`);
				} else {
					return resolve();
				}
			});
		});
	}

	calculateFileSha256Sum(path: string) {
		return new Promise<string>((resolve, reject) => {
			const inputStream = fs.createReadStream(path);
			const hash = crypto.createHash('sha256');

			inputStream.on('readable', () => {
				const data = inputStream.read();
				if (data) {
					hash.update(data);
				} else {
					return resolve(hash.digest('hex'));
				}
			});
		});
	}

	downloadSha256Sum(release: Release, buildName: string) {
		return new Promise<string>((resolve, reject) => {
			let shasumResponse = "";
			https.get(`${releasesUrl}/${release.version}/${release.shasums}`, (response) => {
				response.on('data', (data) => {
					shasumResponse += data;
				});
				response.on('end', () => {
					const shasumLine = shasumResponse.split(`\n`).find(line => line.includes(buildName));
					if (!shasumLine) {
						return reject(`Install error: no matching SHA sum for ${buildName}`);
					}

					return resolve(shasumLine.split("  ")[0]);
				});
			}).on('error', (err) => {
				return reject(err);
			});
		});
	}

	unpack(directory: string, pkgName: string) {
		return new Promise<void>((resolve, reject) => {
			let executable: string;
			yauzl.open(pkgName, { lazyEntries: true }, (err, zipfile) => {
				if (err) {
					return reject(err);
				}
				zipfile.readEntry();
				zipfile.on('entry', (entry) => {
					zipfile.openReadStream(entry, (err, readStream) => {
						if (err) {
							return reject(err);
						}
						readStream.on('end', () => {
							zipfile.readEntry(); // Close it
						});

						executable = `${directory}/${entry.fileName}`;
						const destination = fs.createWriteStream(executable);
						readStream.pipe(destination);
					});
				});
				zipfile.on('close', () => {
					fs.chmodSync(executable, '755');
					return resolve();
				});
			});
		});
	}
}