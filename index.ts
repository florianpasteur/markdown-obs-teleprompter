import marked, {TokensList} from "marked";
import * as fs from "fs";
import * as path from "path";
import * as inquirer from "inquirer";
import chalk from "chalk";
import OBSWebSocket from "obs-websocket-js";
import TerminalRenderer from 'marked-terminal';
// @ts-ignore
import spawn from "spawn-promise";


const SCRIPTS_LOCATION = process.env.SCRIPT_LOCATION || './scripts';

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

(async function () {
    await obs.connect({address: 'localhost:4444', password: ''});
    const scriptFiles = await findMarkdownFilesIn(SCRIPTS_LOCATION);

    const {scriptFileSelected} = await prompt({
        type: "list",
        message: "Select your script:",
        name: "scriptFileSelected",
        choices: scriptFiles
    });

    const scriptContent = await readScriptContent(SCRIPTS_LOCATION, scriptFileSelected);

    const scriptTitle = scriptContent[0].type === "heading" ? scriptContent[0].text : scriptFileSelected;
    const lines = scriptContent.filter((token) => token.type !== "space" && token.type !== "heading") as marked.Tokens.Paragraph[];

    for (const [index, line] of lines.entries()) {
        console.clear()
        console.log(marked(`# Script: ${scriptTitle}`))
        console.log(marked(line.raw))
        const progression = `${index + 1}/${lines.length}`;
        const {textToRecord} = await prompt({
            type: "list", message: `(${progression}) Ready to record ?`, name: "textToRecord", choices: [
                ACTIONS.RECORD,
                ACTIONS.IGNORE
            ]
        });

        if (textToRecord !== ACTIONS.RECORD) {
            continue;
        }

        while (true) {
            const filename = `${scriptFileSelected}-${index + 1}`;
            await setFilename(obs, filename)
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
        }

    }
})()


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
    //console.debug("Recording status", status)
    if (status.isRecording) {
        return new Promise(async resolve => {
            obs.on("RecordingStopped", ({recordingFilename}) => {
                obs.removeAllListeners("RecordingStopped")
                //console.debug("Recording stopped for sure")
                resolve(recordingFilename);
            })
            await obs.send("StopRecording")

            //console.debug("Recording stopped")
        })
    }
    return status.recordingFilename as string;
}

async function startRecording(obs: OBSWebSocket): Promise<string> {
    return new Promise(async resolve => {
        obs.on("RecordingStarted", ({recordingFilename}) => {
            obs.removeAllListeners("RecordingStarted")
            console.log(marked(`## 🔴 Recording...`))
            resolve(recordingFilename);
        })
        await new Promise(resolve => setTimeout(resolve, 500));
        await obs.send("StartRecording")
        //console.debug("Recording started")
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
    GOOD = "✔︎ Good (Save & continue)",
    RETAKE = "🗑 Retake (Delete take & start over)",
    SKIP = "~ Ignore (Delete & continue)",
}
