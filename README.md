# Introduction
Lambda function to send Spring Boot application logs from CloudWatch to Slack.

**WARNING: Lambda calls are not free. Make sure you estimate the cost and configure Billing alarm. Use at your own risk!**

# Features
* fully-configurable via environment variables
* few logging levels (WARNING, ERROR, CRITICAl)
* displays exception that was thrown, error message as well as stacktrace
* navigating to the particular line in the file where exception occurred
* navigating to Kibana
* filtering to reduce number of Slack messages

# Prerequisites
This lambda expects the following log message format:
```json
{
    "time":"2020-09-03T14:33:30.913Z",
    "sev":"ERROR",
    "app":"My Awesome Project",
    "ver":"1.2.3.4",
    "service":"com.awesome.project.service.UserServiceImpl",
    "msg":"User not found",
    "stack_trace":"java.lang.NullPointerException: null\n\tat com...."
}
```

### Severity
Error severity is defined by `sev` field. However it only supports `ERROR` and `WARNING`. 
In order to report `CRITICAL` error - prepend this word to the error message like this:
```java
log.error("CRITICAL: Something wnt really wrong", e);
```

### Version
Field `ver` specifies application version. It follows [semantic versioning](https://semver.org/). 
However, if you format your version as `1.2.3-<branch name>-<commit short SHA>-SNAPSHOT`, this will be parsed by the lambda and properly displayed.
Such functionality is useful when using the lambda on staging environments where multiple branches or features are tested.

### Stacktrack
Field `stack_trace` should contain Java stacktrace without any changes. 
It will be simplified before sending to Slack: framework records will be removed, some packages prefixes could be trimmed as well.

# Usage
Configure CloudWatch streaming to this lambda function. We recommend to filter out everything that is not an error or a warning (`?ERROR ?WARN`) 

# Configuration
Lambda must be configured using environment variables. 

### CHANNEL_NAME
Slack channel name to send. **Required**.  

_Example_: 
```
my-awesome-project-logs
```

### SLACK_PATH
Slack API path provided via Slack admin portal. **Required**.  

_Example_: 
```
/services/aaaaaaa/bbbbbbb/cccccccccc
```

### APPLICATION_NAME
Project name, displayed in notification title. **Required**.  

_Example_: 
```
My Awesome Project
```

### VCS_SEARCH_URL
Url prefix used to build VCS file search url. **Required**.  

We use this url when we cannot convert class package to file path.   
The final URL would be `VCS_SEARCH_URL + className`.  

_Example_: 
```
https://gitlab.com/search?utf8=%E2%9C%93&snippets=false&scope=&repository_ref=master&group_id=12345&project_id=54321&search=
```

### VCS_FILE_URL
Url prefix used to build VCS file/line url. **Required**.  

We use this url when we were able to map class package to file path, so we could point directly to the file (or even line).  
The final URL would be `VCS_FILE_URL + revision + modulePath + packagePath + fileName + #L + lineNumber` where
* _revision_ - master (until we implement version parsing)
* _modulePath_ - base path to module sources (e.g. `awesome-services/src/main/java/com/awesome/project/services`)
* _packagePath_ - relative file path based on package (e.g. `user/`)
* _fileName_ - name of the file (e.g. `UserService.java`)
* _lineNumber_ - line number in the file (e.g `37`)

_Example_: 
```
https://gitlab.com/awesome-project/core/-/blob/
```

### VCS_TREE_URL
Url prefix used to build VCS branch or tag url. **Required**.

We use this url when display application version.  
The final URL would be `VCS_TREE_URL + tagOrVersionName`.  

**Example**: 
```
https://gitlab.com/awesome-project/core/-/tree/
```

### CLASS_PACKAGES
List of project base packages. **Required**.

Used to shorten class names in notification, because Slack forces word wrap, so long lines look ugly.
Multiple packages could be specified, each one is actually regexp pattern.  

_Example_: 
```json
["com.awesome.project"]
```

This will convert everywhere in the message 
```
com.awesome.project.services.user.UserService -> services.user.UserService
```

### EXCEPTION_PACKAGES
List of exception packages. **Required**.    

Used to shorten exception class names in notification, because Slack forces word wrap, so long lines look ugly.
Multiple packages could be specified, each one is actually regexp pattern.  

_Example_: 
```json
["com.awesome.project.exceptions", "com\\.awesome\\.project\\..*.exceptions"]
```

This will convert everywhere in the message
```
com.awesome.project.core.exceptions.UserNotFoundException -> UserNotFoundException
```


### PACKAGE_TO_MODULE_MAPPING
Mapping packages to modules. **Required**.    

Used to determine project path knowing class package.  

_Example_: 
```json
{
    "com.awesome.project.core": "awesome-core",
    "com.awesome.project.controller": "awesome-web",
    "com.awesome.project.services": "awesome-services",
    "com.awesome.project.(\\w+).(\\w+)": "$1-$2"
}
```
  
### KIBANA_BASE_URL
Kibana base URL to be able to navigate to event. **Optional**.      

The link will open the exact event, however it will be possible to navigate to previous events from there.  

_Example_: 
```
https://vpc-es-1-lkj345lkj345kljn6snrbylwe.us-east-1.es.amazonaws.com/_plugin/kibana/app/kibana
```
 
### KIBANA_CONTEXT_URL
Kibana context URL. **Optional**.  

Sometimes this method may noe work due to https://github.com/elastic/kibana/issues/23231.  
 
_Example_: 
```
https://vpc-es-1-lkj345lkj345kljn6snrbylwe.us-east-1.es.amazonaws.com/_plugin/kibana/app/kibana#/context/abcde20-cded-21ac-8343-2234e50f0ade/some-type/
``` 

See https://www.elastic.co/guide/en/kibana/6.8/document-context.html.

### EXCLUDE_FILTERS 
List of regexp filters to use to filter out not relevant logs. **Optional**.  

_Example_: 
```json
[
    { "msg": "Valid authentication is missing in context" },
    { "stack_trace": "org.springframework.security.web.firewall.RequestRejectedException" },
    { "stack_trace": "java.lang.NumberFormatException: For input string: \"\"" }
]
```
