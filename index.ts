#!/usr/bin/env node

import marked, {TokensList} from "marked";
import * as fs from "fs";
import * as path from "path";
import * as inquirer from "inquirer";
import chalk from "chalk";
import OBSWebSocket from "obs-websocket-js";
import TerminalRenderer from 'marked-terminal';
// @ts-ignore
import spawn from "spawn-promise";


const SCRIPTS_LOCATION = process.env.SCRIPT_LOCATION || './';
const RECORD_LOCATION = process.env.RECORD_LOCATION || '~/obs-inbox';

const prompt = inquirer.createPromptModule();
const obs: OBSWebSocket = new OBSWebSocket();
const ffmpeg = (args: string[]) => spawn(process.env.FFMPEG_PATH || "ffmpeg", args);

marked.setOptions({
    renderer: new TerminalRenderer({
        width: 80,
        reflowText: true,
        heading: chalk.red.bold,
        firstHeading: chalk.green.underline.bold,
    })
});

async function saveMetadata(obs: OBSWebSocket, filePath: string, metadata: { [key in string]: string | undefined }) {
    return new Promise(async (resolve, reject) => {
        const destinationFile = filePath + "-metadata.mp4";
        await ffmpeg([
            "-y",
            "-i", filePath,
            ...Object.keys(metadata).flatMap(key => ["-metadata", `${key}=${metadata[key]}`]),
            destinationFile
        ]);

        fs.rename(destinationFile, filePath, function (err) {
            if (err) {
                reject(err);
                return;
            }
            resolve(true)
        });
    })
}

async function getRecordingFilePath(obs: OBSWebSocket) {
    const status = await obs.send("GetRecordingStatus");
    return status.recordingFilename!!
}

async function setFileLocation(obs: OBSWebSocket, fileLocation: string) {
    await obs.send("SetRecordingFolder", {"rec-folder": fileLocation})
}

try {
    (async function () {
        await obs.connect({address: 'localhost:4444', password: ''});
        const scriptFiles = await findMarkdownFilesIn(SCRIPTS_LOCATION);

        const {scriptFileSelected} = await prompt({
            type: "list",
            message: "Select your script:",
            name: "scriptFileSelected",
            choices: scriptFiles
        });

        const loadContent = async () => (await readScriptContent(SCRIPTS_LOCATION, scriptFileSelected)).filter((token) => token.type !== "space" && token.type !== "heading") as marked.Tokens.Paragraph[];
        const scriptContent = await readScriptContent(SCRIPTS_LOCATION, scriptFileSelected);

        const scriptTitle = scriptContent[0].type === "heading" ? scriptContent[0].text : scriptFileSelected;

        for (let lines = await loadContent(), index=0, line=lines[0]; index < lines.length; index++, lines = await loadContent(), line = lines[index]) {
            const printSpeech = () => {
                console.clear()
                console.log(marked(`# Script: ${scriptTitle}`))
                console.log(marked(line.raw))
            }

            printSpeech();
            const progression = `${index + 1}/${lines.length}`;
            const {textToRecord} = await prompt({
                type: "list", message: `(${progression}) Ready to record ?`, name: "textToRecord", choices: [
                    ACTIONS.RECORD,
                    ACTIONS.IGNORE,
                    ACTIONS.PREVIOUS,
                    ACTIONS.RELOAD,
                ]
            });

            if (textToRecord === ACTIONS.PREVIOUS) {
                index -= 2;
                continue;
            }
            if (textToRecord === ACTIONS.RELOAD) {
                index -= 1;
                continue;
            }
            if (textToRecord !== ACTIONS.RECORD) {
                continue;
            }

            while (true) {
                printSpeech();
                const filename = `${scriptFileSelected}-${index + 1}`;
                await setFileLocation(obs, path.join(RECORD_LOCATION, scriptFileSelected));
                await setFilename(obs, filename);
                await stopRecording(obs);
                await startRecording(obs)

                const {takeFeedback} = await prompt({
                    name: "takeFeedback", message: "How was the take", type: "list", choices: [
                        ACTIONS.GOOD,
                        ACTIONS.RETAKE,
                        ACTIONS.SKIP
                    ]
                });

                if (takeFeedback === ACTIONS.GOOD) {
                    const filePath = await getRecordingFilePath(obs);
                    await stopRecording(obs);
                    await saveMetadata(obs, filePath,
                        {
                            title: `${scriptTitle} - ${progression}`,
                            track: progression,
                            description: line.text,
                            lyrics: line.text,
                            album: scriptTitle,
                            copyright: process.env.METADATA_COPYRIGHT,
                            author: process.env.METADATA_AUTHOR,
                            album_artist: process.env.METADATA_AUTHOR,
                        }
                    )
                    break;
                }
                if (takeFeedback === ACTIONS.RETAKE) {
                    await stopRecording(obs);
                    continue;
                }
                if (takeFeedback === ACTIONS.SKIP) {
                    await setFilename(obs, `skip`)
                    await stopRecording(obs);
                    index--;
                    break;
                }
            }

        }
    })()
} catch (e) {
    console.error(e);
    throw e;
}


async function findMarkdownFilesIn(location: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        fs.readdir(location, (err, scriptDir) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(scriptDir.filter(file => file.match(".*\\.md")))
        });
    });
}

async function stopRecording(obs: OBSWebSocket): Promise<string> {
    const status = await obs.send("GetRecordingStatus");
    if (status.isRecording) {
        return new Promise(async resolve => {
            obs.on("RecordingStopped", ({recordingFilename}) => {
                obs.removeAllListeners("RecordingStopped")
                resolve(recordingFilename);
            })
            await obs.send("StopRecording")

        })
    }
    return status.recordingFilename as string;
}

async function startRecording(obs: OBSWebSocket): Promise<string> {
    return new Promise(async resolve => {
        obs.on("RecordingStarted", ({recordingFilename}) => {
            obs.removeAllListeners("RecordingStarted")
            console.log(marked(`## 🔴 Recording... \x07`))
            resolve(recordingFilename);
        })
        await new Promise(resolve => setTimeout(resolve, 500));
        await obs.send("StartRecording")
    })
}

async function setFilename(obs: OBSWebSocket, filename: string) {
    await obs.send("SetFilenameFormatting", {"filename-formatting": filename})
}

async function readScriptContent(location: string, scriptFilename: string): Promise<TokensList> {
    return new Promise((resolve, reject) => {
        fs.readFile(path.join(location, scriptFilename), (err, markdownContent) => {
            if (err) {
                reject(err)
                return;
            }
            resolve(marked.lexer(markdownContent.toString()))
        })
    })
}

enum ACTIONS {
    RECORD = "Record",
    IGNORE = "Ignore",
    PREVIOUS = "Back",
    RELOAD = "Reload script",
    GOOD = "✔︎ Good (Save & continue)",
    RETAKE = "🗑 Retake (Delete take & start over)",
    SKIP = "⏹ Cancel (Delete & continue)",
}
