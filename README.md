# Module Reload

When dependency modules need to be modified at runtime, what is the best approach for making these updates? This document considers some options to address known issues encountered in the current implementation.

The primary issue is that the entire server is restarted upon update, rendering the system temporarily unavailable and causing the original request to update to return in an error response regardless of result.

## Architecture

Before we consider the mechanics of reloading module code, let's first consider the overall system architecture that must be supported.

-   1-n AP2 Servers (e.g., physical machine, VM, container, etc.)

    The system consists of 1 or more independent servers running the same code to handle incoming HTTP requests

-   1 Master Process / Server

    Each server runs a single master process that accepts all incoming requests and distributes them to child processes for handling

-   1-m Child Processes / Server

    Each master process forks 2 or more child processes to handle the incoming requests in order to better leverage multiple cores and threads available on the physical architecture.

## Approach

In order to update module code at runtime, there are several discrete steps that must take place.

1.  Trigger each server to update its local code
1.  Update the module on each server
1.  Notify each child process that the module is updated*
1.  Reload the modules within each child process
1.  [Optional] Notify the original trigger that each child process is updated

The current approach appears to assume only a single AP2 server, rendering Step 1 moot. Step 2 (update), as described below, is relatively straightforward. Step 4 (reload) is currently achieved by terminating the master process, thus negating the need for Step 3 (process notification).

### 1. Trigger Options

An update is initiated by an API call to a running server. This call may be made as a standalone HTTP request or, more generally, through the AP2 UI. The incoming HTTP request is handled by a single child process on a single server. This child process must then notify all servers to perform the update. How should this notification be propagated through the system?

#### Cluster Registration

Each running server may register with a central registration service that keeps a ledger of all running servers. The child process triggering the update may either send a notification to the registration service to forward on to each service, or may query for a list of running servers and send the notification directly.

##### Pros

-   Happens more quickly than polling
-   Allows the initial trigger to monitor the status of each server

##### Cons

-   Requires a registration service

#### DB Polling

Since a shared, central database already exists for the system, implementing the trigger via DB polling may be the simplest approach. An update would be triggered by modifying a value in a database table, while each server's master process would be configured to poll the database at regular intervals to see if the value has changed.

##### Pros

-   Polling can be implemented directly in the master process code with no need to add the complexity of a registration server

##### Cons

-   Delayed execution
-   No way to know if/when each server has seen or acknowledged the update trigger

#### Messaging

If we only need to support a single server, the triggering mechanism can be implemented using the cluster messaging protocol (see [3. Notify Options](#3-notify-options) below), or skipped altogether.

### 2. Update

Once alerted that an update is required, the first step in updating the running modules is to actually fetch and replace the source code on the server. This is generally done via execution of `npm install` on the local machine.

### 3. Notify Options*

Once the module has been updated, each child process must be alerted that a reload is required. Much like the initial trigger, this alert can be configured as either a push or a pull. However, unlike with distributed servers, the master process keeps a list of its child processes and does not need a separate registration service.

__*Note: This notify step is only necessary if the reload step implements the hot-reload option__

#### Messaging

The master process can send messages directly to each child process using the [cluster messaging protocol](https://nodejs.org/api/cluster.html#cluster_worker_send_message_sendhandle_options_callback)

##### Pros

-   No delay
-   Allows the master process to monitor the status of each child process

##### Cons

-   N/A

#### Watching / Polling

Similar to the DB Polling option described in the initial trigger options, some shared resource could be updated to alert all child processes of a change. While a db table could be used, it would require separate records for each server in the system since they will not all have completed the module update at the same time (which could grow indefinitely as servers are possibly swapped in/out). The simplest approach here would be to use a local file that is visible and shared by all child processes, but unique and confined to each server. Still, there is no benefit to this approach over the messaging option described above.

##### Pros

-   N/A

##### Cons

-   Delayed execution
-   No way to know if/when each child process has seen or acknowledged the update trigger

### 4. Reload Options

The final step is to make the updated module code available to each in-memory process.

#### Terminate Master Process

The simplest approach (and what we do now) is to terminate the master process. Since it is launched via nodemon, it is automatically restarted and spawns new child processes.

##### Pros

-   Simple
-   In-flight requests are guaranteed to be atomic

##### Cons

-   Takes down the entire server for some period of time
-   Terminates any in-flight requests, causing the initial update request to appear to fail

#### Hot Reload (Clear Require Cache)

It is possible to configure the server to reload dependencies at the start of each incoming request. This approach incurs a small performance penalty on each request, but provides the benefit of enabling live dependency updates by doing a cache clear in the running process.

A simple example is implemented in the following middleware:
```js
server.use((req, res, next) => {
  require('./app')(req, res, next)
})
```

##### Pros

-   Fast updates
-   Server remains available throughout update
-   In-flight requests are not inhibited

##### Cons

-   Small performance penalty on each incoming request
-   Modifying runtime dependencies is often considered unsafe and can put your system in an undefined state
-   Extreme use-case does not guarantee atomicity of in-flight requests (e.g., if you have a dependency that is imported at runtime within middleware and a request occurs just before cache clear, the request begins with the old module but may load the new one; this can be mitigated by pre-compiling the entire app into a single module)

#### Cycle Child Processes

As something of a hybrid between terminating the master process and doing a hot reload in each child process, we can disconnect and terminate each child process separately. By cycling the child processes separately, the server remains available throughout the update but provides clean processes with well-defined dependencies.

##### Pros

-   Server remains available throughout update
-   In-flight requests are not inhibited
-   In-flight requests are guaranteed to be atomic
-   No runtime performance penalty
-   No runtime state changes

##### Cons

-   Requires either extra time to rotate child processes individually, or a momentary spike in resource consumption for new child processes before the old ones can be terminated
