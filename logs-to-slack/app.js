const https = require('https');
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
 * Url prefix used to build VCS branch or tag url
 * We use this url when display application version
 *
 * The final URL would be
 *      VCS_TREE_URL + tagOrVersionName
 *
 * Example: https://gitlab.com/awesome-project/core/-/tree/
 */
const VCS_TREE_URL = env.VCS_TREE_URL;

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
 * List of regexp filters to use to filter out not relevant logs
 *
 * Example: [
 *      { "msg": "Valid authentication is missing in context" },
 *      { "stack_trace": "org.springframework.security.web.firewall.RequestRejectedException" },
 *      { "stack_trace": "java.lang.NumberFormatException: For input string: \"\"" }
 * ]
 */
const EXCLUDE_FILTERS = JSON.parse(env.EXCLUDE_FILTERS || "[]");

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
        let modulePath = PACKAGE_TO_MODULE_MAPPING[package];

        const regex = hasMethodName
            ? new RegExp(`(${package}[\\.\\d\\w_]*)(\\.[\\d\\w_$]*){2}\\(([^:]*):(\\d+)\\)`)
            : new RegExp(`(${package}.*)\\.([^.]+)`);

        let m;
        if ((m = regex.exec(line)) !== null) {
            let groupsToSkip = 0;
            for (let i = 1; i < 5; i++) {
                const replacedPath = modulePath.replace(`$${i}`, m[i + 1]);
                if (replacedPath !== modulePath) {
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
    }

    return null;
}

function formatException(line) {
    return "*" + EXCEPTION_PACKAGES.reduce((result, pattern) => result.replace(new RegExp(pattern + "\\."), ""), line) + "*";
}

function formatCallLine(line, version) {
    const url = getFileUrl(line, true, version);

    if (url) {
        let temp = CLASS_PACKAGES.reduce((result, pattern) => result.replace(new RegExp("at " + pattern + "\\."), ""), line)
            .replace(/\(<generated>\)/, "")
            .replace(/\$\$[^\\.]+\./, "$$$$.");
        if (temp.includes("(")) {
            return temp
                .replace(/^.*\.([^\.]+\.[^\.]+)(\(.*)$/, "\t_$1_$2")
                .replace(/\((.*):(\d+)\)/gm, ` : <${url}|$2>`);
        } else {
            return temp
                .replace(/^.*\.([^\.]+\.[^\.]+)$/, "\t_$1_")
                .replace(/\((.*):(\d+)\)/gm, ` : <${url}|$2>`);
        }
    } else {
        let temp = CLASS_PACKAGES.reduce((result, pattern) => result.replace(new RegExp("at " + pattern + "\\."), ""), line)
            .replace(/\(<generated>\)/, "")
            .replace(/\$\$[^\.]+\./gm, "$$$$.");
        if (temp.includes("(")) {
            return temp
                .replace(/^.*\.([^\.]+\.[^\.]+)(\(.*)$/, "\t_$1_$2")
                .replace(/\((.*):(\d+)\)/gm, ` : <${VCS_SEARCH_URL}$1|$2>`);
        } else {
            return temp
                .replace(/^.*\.([^\.]+\.[^\.]+)$/, "\t_$1_")
                .replace(/\((.*):(\d+)\)/gm, ` : <${VCS_SEARCH_URL}$1|$2>`);
        }
    }
}

function formatStackTrace(stackTrace, version) {
    const stackTraceLines = stackTrace != null ? stackTrace.split("\n") : [];

    const causedByLine = line => line !== "" && !line.startsWith("\t");
    const atLine = line => line.startsWith("\tat");
    const isOurPackage = line => CLASS_PACKAGES.some(classPackage => line.includes("at " + classPackage + "."));

    return stackTraceLines.reduce((result, line) => {
        if (causedByLine(line)) {
            result.push("!@#$%^&*");
            result.push(formatException(line));
        } else
        if (atLine(line)) {
            if (isOurPackage(line)) {
                result.push(formatCallLine(line, version));
            } else {
                if (result[result.length - 1] !== "\t...") {
                    result.push("\t...");
                }
            }
        } else {
            if (!line.startsWith("\t... ") && line.trim() !== '') {
                result.push(line);
            }
        }

        return result;
    }, [])
}

function calculateColor(logObject) {
    return logObject.msg.includes('CRITICAL')
        ? '#000000'
        : logObject.sev === 'ERROR'
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

function formatVersion(version) {
    if (version === undefined || version.includes("IS_UNDEFINED") ) {
        return "undefined";
    }

    if (version.includes("-SNAPSHOT")) {
        const revision = version.substring(version.length-17, version.length-9);
        const branchWithVersion = version.substring(0, version.length - 18)
        const branch = branchWithVersion.substring(branchWithVersion.indexOf('-') + 1);

        return `<${VCS_TREE_URL}${revision}|${revision}> @ <${VCS_TREE_URL}${branch}|${branch}>`;
    } else {
        const tag = version;

        return `<${VCS_TREE_URL}${tag}|${tag}>`;
    }
}

function prepareMessage(logObject) {
    const formattedStackTrace = formatStackTrace(logObject.stack_trace, logObject.ver)
        .join("\n")
        .split("!@#$%^&*\n")
        .filter(str => str !== "");
    const serviceUrl = getFileUrl(logObject.service, false, logObject.ver);


    const serviceName = CLASS_PACKAGES.reduce((res, pattern) => res.replace(new RegExp(pattern + "\\."), ""), logObject.service)
        .replace(/\$\$[^\.]+\./gm, "$$$$.");
    const service = serviceUrl != null ? `<${serviceUrl}|${serviceName}>` : serviceName;
    const messageColor = calculateColor(logObject);
    const kibanaUrl = buildKibanaUrl(logObject);

    const internalError = logObject.internalError;

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
                        "block_id": "text0"
                    },
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": "*Version:* " + formatVersion(logObject.ver)
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
            let joined = "";
            for(const line of elem.split("\n")) {
                if ((joined + line).length > 3000) {
                    break;
                }
                joined = joined + line + "\n";
            }
            joined = joined.replace(/\s+\.\.\.\s+$/, "");

            result.attachments[0].blocks.push({
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": joined.trim().substring(0, 3000)
                }
            });
        });
    }
    if (internalError) {
        result.attachments[0].blocks.splice(
            1,
            0,
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": `*Status code: ${internalError}*`
                },
            });
    }

    return result;
}

// Send Slack message
async function notifySlack(message) {
    return new Promise((resolve, reject) => {
        const options = {
            "method": "POST",
            "hostname": slackAPIUrl,
            "path": SLACK_PATH,
            "headers": {
                "Content-Type": "application/json"
            }
        };
        //_________________________________________________
        const req = https.request(options, (res) => {
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

function exclude(logObject) {
    for (const entry of EXCLUDE_FILTERS) {
        let matched = true;
        for (const [key, value] of Object.entries(entry)) {
            if (!logObject[key] || !logObject[key].match(value)) {
                matched = false;
                break;
            }
        }
        if (matched) {
            return false;
        }
    }

    return true;
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
        .filter(exclude)
        .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
        .map(prepareMessage)
        .map(notifySlack));
}
