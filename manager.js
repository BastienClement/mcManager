#!/usr/bin/env node
/*
    Copyright (c) 2013-2014 Bastien Clément

    Permission is hereby granted, free of charge, to any person obtaining a
    copy of this software and associated documentation files (the
    "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to
    permit persons to whom the Software is furnished to do so, subject to
    the following conditions:

    The above copyright notice and this permission notice shall be included
    in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
    OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
    IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
    CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
    TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
    SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

var http = require("http");
var fs = require("fs");
var path = require("path");
var WebSocketServer = require("websocket").server;
var spawn = require("child_process").spawn;

var root = path.dirname(process.argv[1]);
var config = require("./config");

//
// Servers
//
// Front cache
var front_end = fs.readFileSync(root + "/front.html");

// HTTP Server
var server = http.createServer(function(req, res) {
    res.write(fs.readFileSync(root + "/front.html"));
    res.end();
});

// SERVER LISTENING PORT
server.listen(8000);

// Websocket server
var wsServer = new WebSocketServer({
    httpServer: server,
    autoAcceptConnections: false
});

//
// Config
//

// User reader
function get_user(name) {
    var user_data;
    for(var group in config.users) {
        if(user_data) break;
        config.users[group].forEach(function(user) {
            if(user_data) return;
            var split = user.split(":");
            if(split[0] == name) {
                user_data = { name: name, pass: split[1], group: group };
            }
        });
    }

    return user_data;
}

function clone(obj) {
    var newObj = {};
    for(var key in obj) {
        newObj[key] = obj[key];
    }
    return newObj;
}

// ACL reader
function acl(user, rule, params) {
    params = params || [];
    user = get_user(user);

    if(!user)
        return false;

    var rules = clone(config.acl.$$);

    function applyRules(selector) {
        var override_rules = config.acl[selector];
        if(!override_rules)
            return;

        if(override_rules.$extends)
            applyRules(override_rules.$extends);

        for(var rule in override_rules) {
            rules[rule] = override_rules[rule];
        }
    }

    applyRules("$" + user.group);
    applyRules(user.name);

    if(rule) {
        var rule = rules[rule];
        if(typeof rule == "function")
            rule = rule.apply(servers, params);
        return rule;
    } else {
        for(var rule in rules) {
            rules[rule] = !!rules[rule];
        }
        return rules;
    }
}

//
// Manager
//
var servers = {};

// Common
function ServerEngineCommon() {
    this.engine = "Generic";
    this.status = 0;
    this.uptime = 0;

    // Parse server.properties file
    this.scanProperties = function() {
        var properties = fs.readFileSync(this.dir + "/server.properties").toString("utf8");
        properties = properties.split("\n");

        var prop_map = {};
        properties.forEach(function(prop) {
            var matches = prop.match(/([a-z0-9_\-]+?)=(.*)/);
            if(matches) {
                prop_map[matches[1]] = matches[2];
            }
        });

        this.properties = prop_map;
        this.port = this.properties["server-port"];
    };
    this.scanProperties();

    // Read the snapshots directory
    this.scanSnapshots = function() {
        try {
            this.snapshots = fs.readdirSync(this.dir + "/snapshots");
        } catch(e) {
            fs.mkdirSync(this.dir + "/snapshots");
            this.snapshots = [];
        }

        this.worlds = [];
        fs.readdirSync(this.dir).forEach(function(file) {
            if(fs.existsSync(this.dir + "/" + file + "/level.dat"))
                this.worlds.push(file);
        }.bind(this));
    };
    this.scanSnapshots();

    // Search a script file
    this.scanScripts = function() {
        if(this.scripts.onUnload)
            this.scripts.onUnload();

        if(fs.existsSync(this.dir + "/scripts.js")) {
            this.scripted = true;
            delete require.cache[require.resolve(this.dir + "/scripts.js")];
            this.scripts = require(this.dir + "/scripts.js");
        } else {
            this.scripted = false;
            this.scripts = {};
        }

        var default_scripts = {
            onLoad: function() { },
            onUnload: function() { },
            onStart: function(cb) { cb(); },
            onStop: function(cb) { cb(); },
            onStopped: function(cb) { cb() },
            onReady: function() { },
            onLog: function() { }
        };

        for(var script in default_scripts) {
            if(!this.scripts[script])
                this.scripts[script] = default_scripts[script];
        }

        this.scripts.onLoad();
    };
    this.scanScripts();
    
    // Returns additional Java parameters
    this.getJavaParams = function() {
        return [];
    };

    // Log Hook
    this.onLog = null;
    this.quiet = false;

    // Log into console
    this.log = function(line) {
        if(this.onLog)
            this.onLog(line);

        if(this.quiet)
            return;

        this.backlog.push(line);
        if(this.backlog.length > 30)
            this.backlog.shift();

        for(var user in users) {
            if(acl(user, "console"))
                users[user].send({ $: "pushConsole", server: this.name, line: line });
        }
    };

    // Minecraft process
    this.mc = null;
    var killTimeout;

    // Starts the server
    this.start = function() {
        if(this.status != 0)
            throw new Error("ce serveur ne peut pas être démarré pour le moment");

        for(var server in servers) {
            if(servers[server].port == this.port && servers[server].status > 0)
                throw new Error("le port de ce serveur entre en conflit avec le serveur '" + server + "'");
        }

        this.status = 1;

        this.runScript("onStart", [function() {
            var mc = spawn("java", this.getJavaParams().concat(["-jar", this.jar]), {
                cwd: this.dir
            });

            this.uptime = +new Date;
            refreshUsers();

            function dataReader(data) {
                var line = data.toString("utf8");

                if(this.status == 2 && line.match(/joined the game/))
                    requestOnlineCheck();

                if(this.status == 2 && line.match(/left the game/))
                    requestOnlineCheck();

                if(this.status == 1 && line.match(/Done \(.*?\)!/)) {
                    this.status = 2;
                    refreshUsers();
                    this.runScript("onReady");
                }

                this.runScript("onLog", [line]);
                this.log(line);
            }

            mc.stdout.on("data", dataReader.bind(this));
            mc.stderr.on("data", dataReader.bind(this));

            mc.on("close", function() {
                this.runScript("onStopped", [function() {
                    this.status = 0;
                    this.mc = null;
                    this.uptime = null;
                    refreshUsers();

                    if(killTimeout)
                        clearTimeout(killTimeout);
                }.bind(this)]);
            }.bind(this));

            this.mc = mc;
        }.bind(this)]);
    }

    // Stops the server (with timer and warning)
    this.stop = function() {
        if(!this.mc || this.status != 2) {
            throw new Error("le serveur n'est pas disponible");
        }

        this.runScript("onStop", [function() {
            this.status = 1;
            refreshUsers();

            this.mc.stdin.write("say Stopping server in 10s\n");
            setTimeout(function() {
                if(this.mc)
                    this.mc.stdin.write("stop\n");
            }.bind(this), 10000);
        }.bind(this)]);
    };

    // Executes a command
    this.execute = function(cmd) {
        if(!this.mc || this.status != 2) {
            throw new Error("le serveur n'est pas disponible");
        }

        this.log(cmd);
        this.mc.stdin.write(cmd + "\n");
    };

    // Stops the server (fast version)
    this.kill = function(notify) {
        if(!this.mc || this.status < 1) {
            throw new Error("le serveur n'est pas actif");
        }

        if(notify) notify("Stopping...");
        this.mc.stdin.write("stop\n");

        killTimeout = setTimeout(function() {
            if(this.mc) {
                if(notify) notify("Sending SIGINT...");
                this.mc.kill("SIGINT");

                killTimeout = setTimeout(function() {
                    if(this.mc) {
                        if(notify) notify("Killing with SIGKILL!");
                        this.mc.kill("SIGKILL");
                    }
                }.bind(this), 5000);
            }
        }.bind(this), 10000);
    };

    // Create snapshot
    this.snapCreate = function(world, notify) {
        if(this.status == 1) {
            throw new Error("ce serveur est occupé");
        }

        if(!world) {
            throw new Error("monde invalide");
        }

        var old_status = this.status;
        this.status = 1;
        refreshUsers();

        function doSnap() {
            if(notify) notify("Création du snapshot...");
            var zip = spawn("zip", ["-r", world + "-snapshot-" + (+new Date) + ".zip", "../" + world ], {
                cwd: this.dir + "/snapshots"
            });

            function notify_stream(data) {
                if(notify) notify(data.toString("utf8"));
            }

            zip.stdout.on("data", notify_stream.bind(this));
            zip.stderr.on("data", notify_stream.bind(this));

            zip.on("close", function() {
                if(notify) notify("Snapshot created!");
                this.scanSnapshots();
                this.status = old_status;
                refreshUsers();
                if(this.mc) {
                    this.mc.stdin.write("save-on\n");
                };
            }.bind(this))
        }

        if(this.mc) {
            if(notify) notify("Le serveur est actif, désactivation de l'auto-sauvegarde...")
            this.mc.stdin.write("save-all\n");
            this.onLog = function(line) {
                if(line.match(/\]: Saved the world/)) {
                    this.mc.stdin.write("save-off\n");
                    this.onLog = null;
                    doSnap.call(this);
                }
            }.bind(this);
        } else {
            doSnap.call(this);
        }
    }

    // Delete snapshot
    this.snapDelete = function(snapshot, notify) {
        fs.unlinkSync(this.dir + "/snapshots/" + snapshot);
        this.scanSnapshots();
        refreshUsers();
        if(notify) notify("Snapshot supprimée!");
    };

    // Restore snapshot
    this.snapRestore = function(world, snapshot, notify) {
        if(this.status != 0) {
            throw new Error("impossible de restaurer un serveur activé");
        }

        this.status = 1;
        refreshUsers();

        function notify_stream(data) {
            if(notify) notify(data.toString("utf8"));
            this.log(data.toString("utf8"));
        }

        var rm = spawn("rm", ["-Rf", world], {
            cwd: this.dir
        });

        rm.stdout.on("data", notify_stream.bind(this));
        rm.stderr.on("data", notify_stream.bind(this));

        rm.on("close", function() {
            var unzip = spawn("unzip", ["snapshots/" + snapshot], {
                cwd: this.dir
            });

            unzip.stdout.on("data", notify_stream.bind(this));
            unzip.stderr.on("data", notify_stream.bind(this));

            unzip.on("close", function() {
                if(notify) notify("Snapshot restored!");
                this.status = 0;
                this.scanSnapshots();
                refreshUsers();
            }.bind(this));
        }.bind(this));
    };

    // Check online users
    this.checkOnline = function() {
        if(this.status == 2 && this.mc) {
            this.quiet = true;
            this.onLog = function(line) {
                var matches = line.match(/\]: There are (\d+)\/\d+ players online/);
                if(matches) {
                    this.players = matches[1] * 1;
                    setTimeout(function() {
                        this.quiet = false;
                        this.onLog = null;
                    }.bind(this), 50);
                }
            }.bind(this);
            this.mc.stdin.write("list\n");
        }
    };

    // Refresh server informations
    this.rescan = function() {
        this.scanSnapshots();
        this.scanScripts();
    };

    // Run a server script
    this.runScript = function(script, args) {
        this.scripts[script].apply(this, args || []);
    };
}

// Classic
function ServerEngineClassic() {
    ServerEngineCommon.call(this);
    this.engine = "Classic";
}

// JSON
function ServerEngineJson() {
    ServerEngineCommon.call(this);
    this.engine = "JSON";
}

//
// ServerManager
//
function ServerManager(name) {
    this.name = name;
    this.dir = root + "/servers/" + name;
    this.tree = {};
    this.jar = "";
    this.status = -1;
    this.players = 0;
    this.port = 0;
    this.uptime = null;
    this.snapshots = [];
    this.properties = {};
    this.backlog = [];
    this.scripted = false;
    this.scripts = {};

    this.scan();

    var jars = [];
    for(var file in this.tree) {
        if(file.match(/\.jar$/)) {
            jars.push(file);
        }
    }

    if(jars.length != 1)
        return;

    this.jar = jars[0];

    if(fs.existsSync(this.dir + "/ops.json"))
        ServerEngineJson.call(this);
    else if(fs.existsSync(this.dir + "/ops.txt"))
        ServerEngineClassic.call(this);

    if(!this.engine)
        return;
}

ServerManager.prototype.scan = function() {
    function buildTree(dir) {
        var tree = {};
        fs.readdirSync(dir).forEach(function(file) {
            var stats = fs.statSync(dir + "/" + file);
            if(stats.isDirectory())
                tree[file] = buildTree(dir + "/" + file);
            else
                tree[file] = dir + "/" + file;

        }.bind(this));
        return tree;
    }

    this.tree = buildTree(this.dir);
};

ServerManager.prototype.prepareJSON = function(user) {
    var mask = {
        "tree": true,
        "jar": true,
        "status": true,
        "players": true,
        "port": true,
        "uptime": function(uptime) {
            if(uptime) {
                var time = (+new Date) - uptime;
                return time + "";
            } else {
                return "Off";
            }
        },
        "snapshots": true,
        "properties": true,
        "engine": true,
        "backlog": function(backlog) { return acl(user, "console", []) ? backlog : []; },
        "worlds": true,
        "scripted": true
    };

    var obj = {};

    for(var key in this) {
        if(mask[key]) {
            if(typeof mask[key] == "function") {
                obj[key] = mask[key](this[key]);
            } else {
                obj[key] = this[key];
            }
        }
    }

    return obj;
};

// Initial scan
function scanServers() {
    for(var server in servers) {
        servers[server].gc = true;
    }

    fs.readdirSync(root + "/servers").forEach(function(server) {
        if(servers[server]) {
            delete servers[server].gc;
            servers[server].rescan();
        } else {
            try {
                var manager = new ServerManager(server);
                servers[server] = manager;
            } catch(e) {
                console.error(e);
            }
        }
    });

    for(var server in servers) {
        if(servers[server].gc) {
            if(servers[server].mc) {
                servers[server].mc.kill("SIGINT");
            }
            delete servers[server];
        }
    }
}

scanServers();

var users = {};

function refreshUsers() {
    for(var user in users) {
        users[user]();
    }
}

setInterval(refreshUsers, 5000);

var checkOnlineTimeout;
function requestOnlineCheck() {
    if(checkOnlineTimeout)
        clearTimeout(checkOnlineTimeout);

    checkOnlineTimeout = setTimeout(function() {
        for(var server in servers) {
            servers[server].checkOnline();
        }
    }, 1000);
}

//
// WebSocket interface
//
wsServer.on("request", function(req) {
    var ws = req.accept();

    function send(obj) {
        ws.send(JSON.stringify(obj));
        if(obj.$ == "kill")
            ws.drop();
    }

    function notify(text) {
        send({ $: "notify", text: text });
    }

    var user;

    function sendStatus() {
        var serv_list = {};
        for(var server in servers) {
            serv_list[server] = servers[server].prepareJSON(user.name);
        }
        send({ $: "servers", list: serv_list });
    }

    function checkPerm(perm, options) {
        if(!user || !acl(user.name, perm, options))
            throw new Error("permission refusée");
    }

    function handle(msg) {
        try {
            switch(msg.$) {
                case "start":
                    checkPerm("start", [msg.server]);
                    servers[msg.server].start();
                    return;

                case "stop":
                    checkPerm("stop", [msg.server]);
                    servers[msg.server].stop();
                    return;

                case "cmd":
                    checkPerm("command", [msg.server, msg.cmd]);
                    servers[msg.server].execute(msg.cmd);
                    return;

                case "kill":
                    checkPerm("kill", [msg.server]);
                    servers[msg.server].kill(notify);
                    return;

                case "snapCreate":
                    checkPerm("snapshot_create", [msg.server, msg.world]);
                    servers[msg.server].snapCreate(msg.world, notify);
                    return;

                case "snapRestore":
                    checkPerm("snapshot_restore", [msg.server, msg.world, msg.snapshot]);
                    servers[msg.server].snapRestore(msg.world, msg.snapshot, notify);
                    return;

                case "snapDelete":
                    checkPerm("snapshot_delete", [msg.server, msg.snapshot]);
                    servers[msg.server].snapDelete(msg.snapshot, notify);
                    return;

                case "rescan":
                    checkPerm("rescan");
                    delete require.cache[require.resolve('./config')];
                    config = require("./config");
                    scanServers();
                    refreshUsers();
                    notify("Serveurs actualisés");
                    return;

                case "crash":
                    checkPerm("debug");
                    process.exit(1);
                    return;

                default:
                    notify("Type de message non géré: " + msg.$);
                    return;
            }
        } catch(e) {
            notify(e.toString());
        }
    }

    notify("Connecté au serveur");
    ws.on("message", function(msg) {
        try {
            msg = JSON.parse(msg.utf8Data);
        } catch(e) {
            return;
        }

        if(!msg.$)
            return;

        if(user)
            return handle(msg);

        switch(msg.$) {
            case "login":
                var user_data = get_user(msg.user);
                if(!user_data) {
                    notify("Nom d'utilisateur incorrect");
                    return;
                }

                if(user_data.pass != msg.pass) {
                    notify("Mot de passe incorrect");
                    return;
                }

                user = user_data;
                send({ $: "login" });
                sendStatus();
                if(users[user.name])
                    users[user.name].send({ $: "kill", error: "connexion depuis un emplacement différent" });
                users[user.name] = sendStatus;
                users[user.name].send = send;
                break;

            default:
                send({ $: "kill", error: "type de message non géré: " + msg.$ });
                return;
        }
    });

    ws.on("close", function() {
        if(user)
            delete users[user];
    });
});

process.on("uncaughtException", function(err) {
    for(var server in servers) {
        var serv = servers[server];
        if(serv.mc) {
            serv.mc.kill("SIGINT");
        }
    }

    console.error(err);
    process.exit(1);
});

process.on("exit", function() {
    for(var server in servers) {
        var serv = servers[server];
        if(serv.mc) {
            serv.mc.kill("SIGINT");
        }
    }
});

global.runCommand = function(cmd, args, cwd, cb) {
    var proc = spawn(cmd, args, { cwd: cwd });

    function log(data) {
        console.log(data.toString("utf8"));
    }

    //proc.stdout.on("data", log);
    proc.stderr.on("data", log);

    proc.on("exit", cb);
}
