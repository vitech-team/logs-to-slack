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
 * Kibana base URL to be able to navigate to event
 *
 * The link will open the exact event, however it will be possible to navigate to previous events from there.
 *
 * Example: https://vpc-es-1-lkj345lkj345kljn6snrbylwe.us-east-1.es.amazonaws.com/_plugin/kibana/app/kibana
 */
const KIBANA_BASE_URL = env.KIBANA_BASE_URL;

/**
 * Kibana context URL
 *
 * Sometimes this method may noe work due to https://github.com/elastic/kibana/issues/23231
 *
 * See https://www.elastic.co/guide/en/kibana/6.8/document-context.html
 *
 * Example: https://vpc-es-1-lkj345lkj345kljn6snrbylwe.us-east-1.es.amazonaws.com/_plugin/kibana/app/kibana#/context/abcde20-cded-21ac-8343-2234e50f0ade/some-type/
 */
const KIBANA_CONTEXT_URL = env.KIBANA_CONTEXT_URL;

/**
 * TODO:
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

function getFileUrl(line, hasMethodName, version) {
    const revision = version !== undefined && !version.includes("IS_UNDEFINED") 
        ? (version.includes("-SNAPSHOT")
            ? version.substring(version.length-17, version.length-9)
            : version)
        : "master";
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

function formatCallLine(line, version) {
    var url = getFileUrl(line, true, version);

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

function formatStackTrace(stackTrace, version) {
    const stackTraceLines = stackTrace != null ? stackTrace.split("\n") : [];

    const causedByLine = line => line != "" && !line.startsWith("\t");
    const atLine = line => line.startsWith("\t");
    const isOurPackage = line => CLASS_PACKAGES.some(package => line.includes("at " + package + "."));

    return stackTraceLines.reduce((result, line) => {
        if (causedByLine(line)) {
            result.push("!@#$%^&*");
            result.push(formatException(line));
        }
        if (atLine(line)) {
            if (isOurPackage(line)) {
                result.push(formatCallLine(line, version));
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

function buildKibanaUrl(logObject) {
    if (KIBANA_BASE_URL) {
        const fromTime = new Date(new Date(logObject.time).getTime() - 5 * 60 * 1000).toISOString();
        const toTime = new Date(new Date(logObject.time).getTime() + 5 * 60 * 1000).toISOString();
        return KIBANA_BASE_URL + `#/discover?_g=(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:'${fromTime}',to:'${toTime}'))&_a=(columns:!(_source),filters:!(),interval:auto,query:(language:kuery,query:'@id:%22${logObject.id}%22'),sort:!(!(time,desc)))`;
    }

    if (KIBANA_CONTEXT_URL) {
        return KIBANA_CONTEXT_URL + logObject.id;
    }

    return null;
}

function prepareMessage(logObject) {
    const formattedStackTrace = formatStackTrace(logObject.stack_trace, logObject.ver)
        .join("\n")
        .split("!@#$%^&*\n")
        .filter(str => str !== "");
    const serviceUrl = getFileUrl(logObject.service, false, logObject.ver);
    const service = serviceUrl != null ? `<${serviceUrl}|${logObject.service}>` : logObject.service;
    const messageColor = calculateColor(logObject);
    const kibanaUrl = buildKibanaUrl(logObject);

    const result = {
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
                    }
                ]
            }
        ]
    };

    if (kibanaUrl) {
        result.attachments[0].blocks[1].accessory =
            {
                "type": "button",
                "text": {
                    "type": "plain_text",
                    "text": "Open in Kibana"
                },
                "url": kibanaUrl
            };
    }

    if (formattedStackTrace) {
        formattedStackTrace.forEach(elem => {
            result.attachments[0].blocks.push({
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": elem
                }
            });
        });
    }

    return result;
}

// Send Slack message
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
        .map(m => {
            let e = JSON.parse(m.message);
            e.id = m.id;
            return e;
        })
        .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
        .map(logObject => prepareMessage(logObject))
        .map(message => notifySlack(message)));
}
