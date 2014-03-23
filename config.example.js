// Users
exports.users = {
    // Group
    admin: [
        // User:Password
		"admin:password",
		"admin2:password"
	],

    // Another group
    guest: [
        // Another user
		"guest:guest"
	]
};

// Permissions are applied (in order):
//     Defaults >> Group >> User
// (the last one is used)
exports.acl = {
    // Default permissions (basis for everyone)
	$$: {
		start: false,
		stop: false,
		kill: false,

		console: false,
		command: false,

		snapshot_create: false,
		snapshot_restore: false,
		snapshot_delete: false,

		rescan: false,
		debug: false
	},

    // Group permission
	$guest: {
        // Smart permission
		start: function(server) {
			if(server == "The Big One")
				return false;

			return true;
		},

        // Create snapshot only if less than 10
		snapshot_create: function(server, world) {
			return this[server].snapshots.length < 10;
		}
	},

    // Another group permission
	$admin: {
	    // Apply permission from another selector
        // before this one (can be recursive)
	    $extends: "$guest",

	    start: true,
	    stop: true,
	    kill: true,
	},

    // User permission
	admin2: {
	    kill: false,
	    debuf: false,
        rescan: false
	}
};
