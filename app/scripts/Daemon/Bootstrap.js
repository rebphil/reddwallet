App.Daemon.Bootstrap = (function () {

    /**
     * The Daemon Bootstrapper initializes a local daemon for use with the wallet. It will return a
     * promise that resolves to a standard Message object indicating if it succeeded or not.
     *
     * @param $q
     * @param $timeout
     * @param $interval
     * @param $rootScope
     * @param {App.Wallet.ConfigModel} walletConfig
     * @param walletDb
     * @constructor
     */

    function Bootstrap ($q, $timeout, $interval, $rootScope, walletConfig, walletDb) {

        this.walletConfig = walletConfig;

        console.logEnabled = walletConfig.config.debug;
        this.killMethod = 'pid'; // either pid or daemon (buggy atm)

        this.$q = $q;
        this.$timeout = $timeout;
        this.$interval = $interval;
        this.$rootScope = $rootScope;
        this.walletRpc = walletDb.walletRpc;

        this.os = require('os');
        this.fs = require('fs');
        this.daemon = null;

        this.deferred = $q.defer();

        this.daemonFilePath = null;
        this.gui = require('nw.gui');
        this.app = this.gui.App;
        this.win = this.gui.Window.get();
        this.childProcess = require('child_process');
        this.pollInterval = walletConfig.config.localDaemon.pollInterval;

        this.daemonDirPath = this.app.dataPath + '/daemon';

        if (walletConfig.config.localDaemon.directory != "$APP") {
            this.daemonDirPath = walletConfig.config.localDaemon.directory;
        }

        this.configPath = this.daemonDirPath + "/reddcoin.conf";
        this.pidPath = this.daemonDirPath + "/reddwallet.pid";

        this.daemonConfig = {};

        this.daemonMap = {
            'linux': {
                'x32': 'daemons/reddcoind-linux-32',
                'x64': 'daemons/reddcoind-linux-64',
                'default': 'daemons/reddcoind-linux-32'
            },
            'win32': {
                'x32': 'daemons/reddcoind-win-32.exe',
                'x64': 'daemons/reddcoind-win-32.exe',
                'default': 'daemons/reddcoind-win-32.exe'
            },
            'darwin': {
                'x64': 'daemons/reddcoind-mac-64',
                'default': 'daemons/reddcoind-mac-64'
            }
        };
        console.log("end of constructor of Bootstrap");
    }

    Bootstrap.prototype = {

        startLocal: function () {
            var self = this;

            console.log("Running pre checks");
            var message = this.runPreChecks();

            if (!message.result) {
                console.log(message.message);

                this.deferred.reject(message);
                self.$rootScope.$broadcast('daemon.bootstrapped', message);

                return this.deferred.promise;
            }

            console.log("Init config...");
            var promise = this.initializeConfiguration();

            promise.then(
                function success () {

                    console.log("Running pre daemon spawn tasks");
                    self.parseConfigurationFiles();
                    self.runOsSpecificTasks();

                    var killPromise = self.killExistingPid();

                    killPromise.then(
                        function success() {
                            self.startDaemonLaunch();
                        },
                        function error() {
                            self.startDaemonLaunch();
                        }
                    );

                },
                function error (err) {
                    self.deferred.reject(new App.Global.Message(false, 4, err));
                }
            );

            return this.deferred.promise;
        },

        /**
         * Checks that the daemon can run on the OS, initialises the path to the daemon & makes sure
         * the daemon actually exists.
         *
         * @returns {App.Global.Message}
         */
        runPreChecks: function () {
            if (!this.hasValidDaemon()) {
                return new App.Global.Message(
                    false, 1, 'This operating system does not support running the Reddcoin daemon.'
                );
            }

            this.initializeFilePath();

            if (!this.fs.existsSync(this.daemonFilePath)) {
                var platform = this.os.platform() + ' ' + this.os.arch();
                return new App.Global.Message(
                    false, 2, 'Cannot find the daemon for this operating system: ' + platform
                );
            }

            return new App.Global.Message(true, 0, 'Pre-checks complete');
        },

        /**
         * Runs commands based on the OS, on *nix you need the chmod the daemon just in case.
         */
        runOsSpecificTasks: function() {
            if (!this.isWindows()) {
                console.log("Chmodding " + this.daemonFilePath);

                try {
                    var result = this.fs.chmodSync(this.daemonFilePath, '775');
                } catch (error) {
                    console.log(error);
                }

                console.log("Chmod Sync Finish");
            }
        },

        startDaemonLaunch: function() {
            var self = this;

            console.log("Starting Daemon Launch");

            // Also initialize the walletRpc configuration..
            // This is so we can use an RPC call to wait on the daemon to start..
            this.walletRpc.initializeConfig(this.daemonConfig);

            console.log("spawnDaemon()");
            this.spawnDaemon();

            // We will do an interval function to check every second to see if the daemon has loaded.
            var daemonStartedSuccess = function success (message) {
                console.log("Daemon has started...");

                var newMessage = new App.Global.Message(true, 0, 'Daemon Ready');

                self.deferred.resolve(newMessage);

                self.$rootScope.$broadcast('daemon.bootstrapped', newMessage);

                console.log(newMessage);

                // Setup an internal to emit a notification of a 'block' as want the wallet to stay up to date even
                // if no actions are performed. If the wallet is connected to an already started external daemon
                // then we wont receive its alerted notifications.
                // This wallet is not designed to connect to daemons outside of a local network as it may be sluggish.
                var blockInterval = self.$interval(function() {
                    self.$rootScope.$broadcast('daemon.notifications.block');
                }, self.pollInterval * 1000);

                self.$interval.cancel(intervalCode);

            };

            var intervalCode = this.$interval(function() {
                self.walletRpc.lockWallet().then(
                    daemonStartedSuccess,
                    function error (message) {
                        if (message.rpcError.code == undefined) {
                            console.log("Daemon still not started.. (weird rpcError)");
                            console.log(message);
                            return;
                        }

                        if (message.rpcError.code == 'ECONNREFUSED') {
                            console.log("Daemon still not started..");
                            console.log(message);
                        } else if (message.rpcError.code == -15) {
                            daemonStartedSuccess(message);
                            console.log("Error code -15, not encrypted");
                        } else {
                            console.log(message);
                        }
                    }
                );

            }, 1000);
        },

        /**
         * This will check if the data directory contains the ReddWallet daemon folder & configuration. If it doesn't
         * then it will create the folder and configuration file. After that it will set the config by reading the file.
         */
        initializeConfiguration: function() {
            var self = this;
            var deferred = this.$q.defer();

            try {

                console.log("Checking if the daemon directory exists...");
                // Check if the daemon data directory exists
                if (!this.fs.existsSync(this.daemonDirPath)) {
                    this.fs.mkdirSync(this.daemonDirPath);
                    console.log("Created directory for " + this.daemonDirPath);
                }

                // Check if the daemon directory has a reddcoin.conf file, if not then create one
                console.log("Checking if the reddcoin.conf file exists...");
                if (!this.fs.existsSync(this.configPath)) {
                    console.log("Copying default config over to app data dir");
                    var defaultConf = this.fs.readFileSync('daemons/reddcoin.default.conf', {
                        encoding: 'utf8'
                    });

                    console.log("Generating random password for daemon rpc...");
                    // Replace the %PASSWORD with a random value..
                    var crypto = require('crypto');
                    crypto.randomBytes(32, function(ex, buf) {
                        if (ex == null) {
                            defaultConf = defaultConf.replace("$PASSWORD", crypto.pseudoRandomBytes(32).toString('hex'));
                        } else {
                            defaultConf = defaultConf.replace("$PASSWORD", buf.toString('hex'));
                        }

                        self.fs.writeFileSync(self.configPath, defaultConf);
                        console.log("Copied default daemon configuration file to " + self.configPath);
                        deferred.resolve();
                    });
                } else {
                    // It does exist.
                    deferred.resolve();
                }

            } catch (ex) {
                deferred.reject(ex);
                console.log("Error initializing daemon configuration. " + ex);
            }

            return deferred.promise;
        },

        parseConfigurationFiles: function () {
            try {

                var daemonConf = this.fs.readFileSync(this.configPath, {
                    encoding: 'utf8'
                });

                var lines = daemonConf.split("\n");
                for (var i = 0; i < lines.length; i++) {
                    var parts = lines[i].split("=");
                    if (parts.length == 2) {
                        this.daemonConfig[parts[0].trim()] = parts[1].trim();
                    }
                }

            } catch (ex) {
                this.deferred.reject("An error occurred whilst trying to parse the daemon configuration file.");
            }
        },

        /**
         * Spawns the daemon.
         */
        spawnDaemon: function() {
            var self = this;

            try {
                console.log("spawnDaemon() - spawning...");

                var argument = [
                    '-conf=' + self.configPath,
                    '-datadir=' + self.daemonDirPath,
                    '-alertnotify=echo "ALERT:%s"',
                    '-walletnotify=echo "WALLET:%s"',
                    '-blocknotify=echo "BLOCK:%s"'
                ];

                console.log(argument);

                self.daemon = self.childProcess.spawn(self.daemonFilePath, argument);

                console.log("setupDaemonListeners()");
                self.setupDaemonListeners();

                console.log("saveDaemonPid()");
                self.saveDaemonPid();

            } catch (ex) {
                console.log(ex);
                self.deferred.reject(new App.Global.Message(
                    false, 2, "We cannot start the daemon, please check no other wallets are running."
                ));
            }
        },

        /**
         * The daemon outputs various data, setup listeners to catch this fire and off events.
         */
        setupDaemonListeners: function () {
            var self = this;

            // When the main window (the one starting this) is closed, kill the daemon.
            this.win.on('close', function() {
                self.daemon.kill('SIGTERM', function() {
                    console.log("Daemon killed");
                });

                this.close(true);
            });

            self.daemon.stderr.setEncoding('utf8');
            self.daemon.stderr.on('data', function (data) {

                if (/^execvp\(\)/.test(data) || data.toLowerCase().indexOf("error") !== -1) {
                    console.log('Failed to start child process. ' + data);
                    self.deferred.reject(new App.Global.Message(
                        false, 2, data
                    ));
                }

                if (data.indexOf("Corrupted block database detected") !== -1) {
                    data = "Corrupt block database detected, please reindex or delete the block database to rebuild it.";
                }

                self.deferred.reject(new App.Global.Message(
                    false, 2, data
                ));

            });

            self.daemon.stdout.setEncoding('utf8');
            self.daemon.stdout.on('data', function (data) {
                if (data.indexOf('BLOCK') !== -1) {
                    self.$rootScope.$emit('daemon.notifications.block');
                    console.log("[BLOCK] Notification " + data);
                } else if (data.indexOf('ALERT') !== -1) {
                    self.$rootScope.$emit('daemon.notifications.alert');
                    console.log("[ALERT] Notification " + data);
                } else if (data.indexOf('WALLET') !== -1) {
                    self.$rootScope.$emit('daemon.notifications.wallet');
                    console.log("[WALLET] Notification " + data);
                }
            });

            this.daemon.on('close', function (data) {
                self.fs.unlink(self.pidPath, function(ex) {
                    if (ex != null) {
                        console.log(ex);
                    }
                });

                console.log("Daemon child process has ended.");
                console.log(data);
            });
        },

        /**
         * If a platform is found, the daemon has to have a workable version on the OS.
         *
         * @returns {boolean}
         */
        hasValidDaemon: function() {
            var platform = this.os.platform();
            return this.daemonMap[platform] !== undefined;
        },

        /**
         * Gets the correct path to the daemon.
         */
        initializeFilePath: function() {
            var osArch = this.os.arch();
            var osPlatform = this.os.platform();

            var platform = this.daemonMap[osPlatform];

            if (platform !== undefined) {
                // There is a platform, which means we can definitely run the default...
                if (platform[osArch] == undefined) {
                    // Default architecture.. (likely will be 32bit)
                    this.daemonFilePath = platform['default'];
                } else {
                    this.daemonFilePath = platform[osArch];
                }
            }
        },

        /**
         * Save the current daemon process ID to the database, this is so we
         * can kill any daemon upon restart if it didn't get closed.
         *
         * @param {function=} callback
         */
        saveDaemonPid: function(callback) {
            this.fs.writeFileSync(this.pidPath, this.daemon.pid, {
                flag: 'w'
            });
        },

        /**
         * Retrieves the previously saved process ID and tries to kill it, it then deletes
         * the record from the DB.
         *
         */
        killExistingPid: function() {
            var self = this;
            var deferred = this.$q.defer();

            if (self.killMethod == 'pid') {
                if (self.fs.existsSync(self.pidPath)) {
                    var pid = self.fs.readFileSync(this.pidPath, {
                        encoding: 'utf8'
                    });
                    try {
                        process.kill(pid, 'SIGTERM');
                        self.$timeout(function() {
                            console.log("Resolved");
                            deferred.resolve(true);
                        }, 500);
                    } catch (ex) {
                        console.log("Error trying to kill with PID, most likely no process exists with that PID");
                        deferred.reject(false);
                    }
                } else {
                    deferred.resolve(true);
                }
            }

            return deferred.promise;
        },

        /**
         * Returns the promise that is resolved when the daemon is initialized.
         *
         * @returns {promise|defer.promise|Promise.promise|Q.promise}
         */
        getPromise: function() {
            return this.deferred.promise;
        },

        /**
         * Determines whether the current platform is windows or not.
         *
         * @returns {boolean}
         */
        isWindows: function() {
            return this.os.platform() === 'win32';
        },

        /**
         * Tries to kill the daemon
         */
        killDaemon: function () {
            this.daemon.kill('SIGTERM');
        },

        /**
         * If debugging is enabled, it will log it to the console.
         *
         * @param data
         */
        debug: function (data) {
            if (console.logEnabled) {
                console.log(data);
            }
        }

    };


    return Bootstrap;

}());
