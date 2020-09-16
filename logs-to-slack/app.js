var https = require('https');
const zlib = require('zlib');
const {env} = require('process');

/**
 * This lambda expects the following log message format:
 * {
 *      "time":"2020-09-03T14:33:30.913Z",
 *      "sev":"ERROR",
 *      "app":"My Awesome Project",
 *      "ver":"1.2.3.4",
 *      "service":"com.awesome.project.service.UserServiceImpl",
 *      "msg":"User not found",
 *      "stack_trace":"java.lang.NullPointerException: null\n\tat com...."
 * }
 */

/**
 * Slack channel name to send
 *
 * Example: my-awesome-project-logs
 */
const CHANNEL_NAME = env.CHANNEL_NAME;

/**
 * Slack API path provided via Slack admin portal
 *
 * Example: /services/aaaaaaa/bbbbbbb/cccccccccc
 */
const SLACK_PATH = env.SLACK_PATH;

/**
 * Project name, will be displayed in notification title
 *
 * Example: My Awesome Project
 */
const APPLICATION_NAME = env.APPLICATION_NAME;

/**
 * Url prefix used to build VCS file search url
 * We use this url when we cannot convert class package to file path
 *
 * The final URL would be
 *      VCS_SEARCH_URL + className
 *
 * Example: https://gitlab.com/search?utf8=%E2%9C%93&snippets=false&scope=&repository_ref=master&group_id=12345&project_id=54321&search=
 */
const VCS_SEARCH_URL = env.VCS_SEARCH_URL;

/**
 * Url prefix used to build VCS file/line url
 * We use this url when we were able to map class package to file path, so we could point directly to the file (or even line)
 *
 * The final URL would be
 *      VCS_FILE_URL + revision + modulePath + packagePath + fileName + #L + lineNumber
 * where
 *      revision - master (until we implement version parsing)
 *      modulePath - base path to modlue sources (e.g. awesome-services/src/main/java/com/awesome/project/services)
 *      packagePath - relative file path based on package (e.g. user/)
 *      fileName - name of the file (e.g. UserService.java)
 *      lineNumber - line number in the file (e.g 37)
 *
 * Example: https://gitlab.com/awesome-project/core/-/blob/
 */
const VCS_FILE_URL = env.VCS_FILE_URL;

/**
 * List of project base packages.
 * Used to shorten class names in notification, because Slack forces word wrap, so long lines look ugly.
 * Multiple packages could be specified, each one is actually regexp pattern
 *
 * Example: ["com.awesome.project"]
 * This will convert everywhere in the message
 *      com.awesome.project.services.user.UserService -> services.user.UserService
 */
const CLASS_PACKAGES = JSON.parse(env.CLASS_PACKAGES);

/**
 * List of exception packages.
 * Used to shorten exception class names in notification, because Slack forces word wrap, so long lines look ugly.
 * Multiple packages could be specified, each one is actually regexp pattern
 *
 * Example: ["com.awesome.project.exceptions", "com\\.awesome\\.project\\..*.exceptions"]
 * This will convert everywhere in the message
 *      com.awesome.project.core.exceptions.UserNotFoundException -> UserNotFoundException
 */
const EXCEPTION_PACKAGES = JSON.parse(env.EXCEPTION_PACKAGES);

/**
 * Mapping packages to modules
 * Used to determine project path knowing class package.
 *
 * Example: {
 *      "com.awesome.project.core": "awesome-core",
 *      "com.awesome.project.controller": "awesome-web",
 *      "com.awesome.project.services": "awesome-services",
 *      "com.awesome.project.(\\w+).(\\w+)": "$1-$2"
 * }
 */
const PACKAGE_TO_MODULE_MAPPING = JSON.parse(env.PACKAGE_TO_MODULE_MAPPING);

/**
 * TODO:
 *      * support version parsing
 *      * implement filters (include, exclude)
 *      * add nodejs errors support
 */

const slackAPIUrl = `hooks.slack.com`;

// Decode from base64, unzip and parse CloudWatch event payload
const decodeAndUnzip = (data) => {
    const compressedPayload = Buffer.from(data, 'base64');
    const jsonPayload = zlib.gunzipSync(compressedPayload).toString('utf8');
    return JSON.parse(jsonPayload);
}

function getFileUrl(line, hasMethodName) {
    const revision = "master";
    const javaFolder = "src/main/java";

    for (let package in PACKAGE_TO_MODULE_MAPPING) {
        var modulePath = PACKAGE_TO_MODULE_MAPPING[package];

        const regex = hasMethodName
            ? new RegExp(`(${package}[\\.\\d\\w_]*)(\\.[\\d\\w_$]*){2}\\(([^:]*):(\\d+)\\)`)
            : new RegExp(`(${package}\\..*)\\.([^.]+)`);

        let m;
        if ((m = regex.exec(line)) !== null) {
            let groupsToSkip = 0;
            for (var i = 1; i < 5; i++) {
                const replacedPath = modulePath.replace(`$${i}`, m[i + 1]);
                if (replacedPath != modulePath) {
                    modulePath = replacedPath;
                    groupsToSkip++;
                }
            }

            const packagePath = m[1];
            if (hasMethodName) {
                const lineNumber = m[4 + groupsToSkip];
                const fileName = m[3 + groupsToSkip];
                return `${VCS_FILE_URL}/${revision}/${modulePath}/${javaFolder}/${packagePath.replace(/\./g, "/")}/${fileName}#L${lineNumber}`.replace(/([^:])\/{2,}/g, "$1/");
            } else {
                const className = m[2 + groupsToSkip];
                return `${VCS_FILE_URL}/${revision}/${modulePath}/${javaFolder}/${packagePath.replace(/\./g, "/")}/${className}.java`.replace(/([^:])\/{2,}/g, "$1/");
            }
        }
    };

    return null;
}

function formatException(line) {
    return "*" + EXCEPTION_PACKAGES.reduce((result, pattern) => result.replace(new RegExp(pattern + "\\."), ""), line) + "*";
}

function formatCallLine(line) {
    var url = getFileUrl(line, true);

    if (url) {
        return CLASS_PACKAGES.reduce((result, pattern) => result.replace(new RegExp("at " + pattern + "\\."), ""), line)
            .replace(/\$\$[^\.]+\./, "$$$$.")
            .replace(/\((.*):(\d+)\)/gm, ` : <${url}|$2>`);

    } else {
        return CLASS_PACKAGES.reduce((result, pattern) => result.replace(new RegExp("at " + pattern + "\\."), ""), line)
            .replace(/\$\$[^\.]+\./gm, "$$$$.")
            .replace(/\((.*):(\d+)\)/gm, ` : <${VCS_SEARCH_URL}$1|$2>`);
    }
}

function formatStackTrace(stackTrace) {
    const stackTraceLines = stackTrace != null ? stackTrace.split("\n") : [];

    const causedByLine = line => line != "" && !line.startsWith("\t");
    const atLine = line => line.startsWith("\t");
    const isOurPackage = line => CLASS_PACKAGES.some(package => line.includes("at " + package + "."));

    return stackTraceLines.reduce((result, line) => {
        if (causedByLine(line)) {
            result.push(formatException(line));
        }
        if (atLine(line)) {
            if (isOurPackage(line)) {
                result.push(formatCallLine(line));
            } else {
                if (result[result.length - 1] != "\t...") {
                    result.push("\t...");
                }
            }
        }

        return result;
    }, [])
}

function calculateColor(logObject) {
    return logObject.msg.includes('CRITICAL')
        ? '#000000'
        : logObject.sev == 'ERROR'
            ? '#FF0000'
            : '#FFD300';
}

function prepareMessage(logObject) {
    const formattedStackTrace =  formatStackTrace(logObject.stack_trace).join("\n").substring(0, 2999);
    const serviceUrl = getFileUrl(logObject.service, false);
    const service = serviceUrl != null ? `<${serviceUrl}|${logObject.service}>` : logObject.service ;
    const messageColor = calculateColor(logObject);

    return {
        "channel": CHANNEL_NAME,
        "text": `*${APPLICATION_NAME}* @ ${logObject.time}`,
        "icon_emoji": ":aws:",
        "attachments": [
            {
                "color": messageColor,
                "blocks": [
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": "*Class:* " + service
                        },
                        "block_id": "text1"
                    },
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": `*Message:* ${logObject.msg}`
                        },
                        "block_id": "text2"
                    },
                    {
                        "type": "divider"
                    },
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": formattedStackTrace
                        }
                    }
                ]
            }
        ]
    };
}

// Send Slack messaeg
async function notifySlack(message) {
    return new Promise((resolve, reject) => {
        var options = {
            "method": "POST",
            "hostname": slackAPIUrl,
            "path": SLACK_PATH,
            "headers": {
                "Content-Type": "application/json"
            }
        };
        //_________________________________________________
        var req = https.request(options, (res) => {
            resolve(res);
        });

        req.on('error', (e) => {
            reject(e);
        });
        // send the request
        req.write(JSON.stringify(message));
        req.end();
    });
}

exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    const data = decodeAndUnzip(event.awslogs.data);

    await Promise.all(data
        .logEvents
        .map(event => JSON.parse(event.message))
        .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
        .map(logObject => prepareMessage(logObject))
        .map(message => notifySlack(message)));
}
