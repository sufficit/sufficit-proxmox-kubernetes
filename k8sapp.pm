package PVE::API2::K8sApp;

use strict;
use warnings;

use Fcntl qw(F_GETFD F_SETFD FD_CLOEXEC);
use JSON qw(decode_json encode_json);
use PVE::API2Tools;
use PVE::AccessControl;
use PVE::Cluster;
use PVE::Exception qw(raise raise_perm_exc raise_param_exc);
use PVE::RESTHandler;
use PVE::RPCEnvironment;
# upid_decode/upid_normalize_status_type are NOT in PVE::Tools' @EXPORT_OK
# (only split_list is): call those fully qualified.
use PVE::Tools qw(file_get_contents run_command split_list);
use PVE::JSONSchema qw(get_standard_option);
use PVE::INotify;
use PVE::SafeSyslog;
use File::ReadBackwards;

use base qw(PVE::RESTHandler);

my $apps_file = '/usr/share/pve-manager/js/k8s/apps.json';
my $history_file = '/usr/share/pve-manager/js/k8s/history.json';
my $notes_file = '/usr/share/pve-manager/js/k8s/notes.json';
# User state lives with the other PVE state (jobs/, pkgupdates/): /var/lib is
# writable by pvedaemon (root, where the protected PUT runs) and its
# world-readable files are served by the pveproxy workers (www-data).
# /usr/share is package static assets -- never a data store (that mismatch
# produced the "unable to open file ... Permission denied (500)" on save).
my $notes_dir = '/var/lib/pve-manager/k8s';
my $notes_store = "$notes_dir/notes.json";# Static files under /usr/share are owned by the package manager and are not a
# writable data store. Keep the UI snapshot there, but persist user data in the
# normal PVE state directory (shared on clustered filesystems).
sub read_notes {
    for my $filename ($notes_store, $notes_file) {
        my $notes = eval { decode_json(file_get_contents($filename, 1024 * 1024)) };
        return $notes if $notes && ref($notes) eq 'HASH';
    }
    return {};
}

sub write_notes {
    my ($notes) = @_;
    mkdir $notes_dir if !-d $notes_dir;
    # 0644: the GET /config handler runs in the pveproxy worker (www-data),
    # only the protected PUT lands in pvedaemon (root).
    PVE::Tools::file_set_contents($notes_store, encode_json($notes), 0644);
}

sub read_json_file {
    my ($filename) = @_;
    my $raw = eval { file_get_contents($filename, 32 * 1024 * 1024) };
    return undef if !$raw;
    return eval { decode_json($raw) };
}

sub app_from_id {
    my ($appid) = @_;
    my ($namespace, $name) = split(/:/, $appid, 2);
    return undef if !defined($namespace) || !defined($name) || $namespace eq '' || $name eq '';
    my $data = read_json_file($apps_file) || {};
    for my $app (@{ $data->{apps} || [] }) {
        return $app if ($app->{namespace} // '') eq $namespace && ($app->{name} // '') eq $name;
    }
    return undef;
}

sub check_audit {
    my ($node) = @_;
    my $rpcenv = PVE::RPCEnvironment::get();
    my $user = $rpcenv->get_user();
    $rpcenv->check($user, "/nodes/$node", ['Sys.Audit']);
}

sub check_console {
    my ($node) = @_;
    my $rpcenv = PVE::RPCEnvironment::get();
    my $user = $rpcenv->get_user();
    $rpcenv->check($user, "/nodes/$node", ['Sys.Console']);
}

sub check_modify {
    my ($node) = @_;
    my $rpcenv = PVE::RPCEnvironment::get();
    my $user = $rpcenv->get_user();
    $rpcenv->check($user, "/nodes/$node", ['Sys.Modify']);
}

# pvedaemon runs with taint mode (-T): every value that reaches exec() must be
# laundered, like the Qemu/LXC handlers do.
sub launder {
    my ($value, $what) = @_;
    $value //= '';
    $value =~ m/^([A-Za-z0-9][A-Za-z0-9._-]*)$/
        or raise_param_exc({ $what => 'invalid characters in value' });
    return $1;
}

sub run_kubectl {
    my (@args) = @_;
    my @cmd = ('/usr/local/bin/k3s', 'kubectl', @args);
    my ($out, $err) = ('', '');
    my $ok = eval {
        # PVE::Tools::run_command delivers each line WITHOUT the trailing
        # newline; re-append it so multi-line output (yaml/describe/logs)
        # keeps its structure.
        run_command(\@cmd,
            outfunc => sub { $out .= shift . "\n" },
            errfunc => sub { $err .= shift . "\n" });
        1;
    };
    if (!$ok) {
        my $msg = $@;
        $msg =~ s/ at \S+ line \d+.*$//s;
        chomp($err);
        chomp($msg);
        my $text = ($err ne '' ? $err : $msg) || 'kubectl failed';
        die "$text\n";
    }
    return $out;
}

# The interactive terminal uses the same PVE termproxy/vncwebsocket protocol
# as VM/LXC consoles. The actual command stays inside the selected pod: only
# the namespace, pod and container come from the trusted app snapshot; the
# browser never receives a host shell or a kubeconfig.
my @console_shells = ('/bin/sh', '/bin/bash', '/bin/ash');

# Probe the common shells in order inside the selected container. A distroless
# image has none of them; then the caller falls back to `kubectl debug` with a
# busybox shell (an ephemeral container sharing the pod). Only shell paths are
# probed; no user-supplied command is ever accepted.
sub console_shell {
    my ($app, $pod, $container) = @_;
    my $namespace = launder($app->{namespace}, 'namespace');
    my $podname = launder($pod, 'pod');
    for my $shell (@console_shells) {
        my @probe = ('/usr/local/bin/k3s', 'kubectl', '-n', $namespace, 'exec', $podname);
        push @probe, ('-c', launder($container, 'container'))
            if defined($container) && $container ne '';
        push @probe, ('--', $shell, '-c', 'true');
        return $shell if eval { run_command(\@probe); 1 };
    }
    return undef;
}

sub console_command {
    my ($app, $pod, $container, $shell) = @_;
    my $namespace = launder($app->{namespace}, 'namespace');
    my $podname = launder($pod, 'pod');

    # Primary path: an interactive shell in the app's own container.
    if (defined($shell)) {
        my @cmd = ('/usr/local/bin/k3s', 'kubectl', '-n', $namespace,
            'exec', '-i', '-t', $podname);
        push @cmd, ('-c', launder($container, 'container'))
            if defined($container) && $container ne '';
        push @cmd, '--', $shell;
        return \@cmd;
    }

    # Fallback for distroless images: an ephemeral busybox container attached
    # to the pod (shares the network namespace, and with --target also the
    # process namespace of the app container). The busybox image ships in the
    # local k3s registry cache of this POC host. Note: like every
    # `kubectl debug`, the ephemeral container stays in the pod spec until the
    # pod is recreated.
    my @cmd = ('/usr/local/bin/k3s', 'kubectl', '-n', $namespace,
        'debug', '-i', '-t', "pod/$podname", '--image', 'busybox:1.36');
    push @cmd, ('--target', launder($container, 'container'))
        if defined($container) && $container ne '';
    push @cmd, '--', '/bin/sh';
    return \@cmd;
}

# Ticket path shared by termproxy (assemble) and vncwebsocket (verify). Built
# from the trusted snapshot with laundered values so both sides agree, taint
# mode accepts it on exec() and PVE::AccessControl::normalize_path keeps it:
# only alnum . - _ / are allowed there, so the appid separator must be '/'
# (never the ':' of the appid itself).
sub console_authpath {
    my ($rawnode, $appid) = @_;
    my $app = app_from_id($appid);
    raise_param_exc({ appid => 'Kubernetes application not found' }) if !$app;
    my $node = launder($rawnode, 'node');
    my $ns = launder($app->{namespace}, 'namespace');
    my $name = launder($app->{name}, 'name');
    return "/nodes/$node/k8sapp/$ns/$name";
}

sub start_termproxy {
    my ($param, $app, $pod, $container) = @_;
    my $rpcenv = PVE::RPCEnvironment::get();
    my $authuser = $rpcenv->get_user();
    my $node = $param->{node};
    my $appid = $param->{appid};
    my $authpath = console_authpath($node, $appid);
    my $family = PVE::Tools::get_host_address_family($node);
    my $port = PVE::Tools::next_vnc_port($family);
    my $ticket = PVE::AccessControl::assemble_vnc_ticket($authuser, $authpath, $port);
    my $shell = console_shell($app, $pod, $container);
    my $shcmd = console_command($app, $pod, $container, $shell);

    my $realcmd = sub {
        my ($upid) = @_;
        syslog('info', "starting k8sapp termproxy $upid\n");

        pipe(my $ticket_rd, my $ticket_wr) or die "failed to create pipe: $!\n";

        my $flags = fcntl($ticket_rd, F_GETFD, 0)
            // die "failed to get file descriptor flags: $!\n";
        fcntl($ticket_rd, F_SETFD, $flags & ~FD_CLOEXEC)
            // die "failed to remove CLOEXEC flag from fd: $!\n";

        my $cmd = [
            '/usr/bin/termproxy',
            $port,
            '--path',
            $authpath,
            '--perm',
            'Sys.Console',
            '--vncticket-endpoint',
            '--verify-port',
            '--ticket-fd',
            fileno($ticket_rd),
            '--',
            @$shcmd,
        ];
        my $afterfork = sub {
            print {$ticket_wr} $ticket;
            close($ticket_wr);
        };
        run_command($cmd, afterfork => $afterfork);
    };

    my $upid = $rpcenv->fork_worker('k8stermproxy', k8s_task_id($appid), $authuser, $realcmd);
    # wait_for_vnc_port dies after its timeout, which would turn an otherwise
    # working proxy into a 500: on this host it also times out for the NATIVE
    # /nodes/{node}/termproxy (termproxy binds ~2s later, listens 10s for the
    # client). Non-fatal here: if the port is not up when the browser
    # connects, the websocket gets a clean refusal and Connect can be retried.
    eval { PVE::Tools::wait_for_vnc_port($port, undef, 8); 1 };
    return { user => $authuser, ticket => $ticket, port => $port, upid => $upid };
}

sub action_returns {
    # Mutating actions return the UPID of their background task, the same
    # contract the guest start/stop endpoints have: the UI opens the standard
    # task progress/viewer on it, and the task lands in the node task list,
    # /cluster/tasks and the cluster log like every other Proxmox activity.
    return { type => 'string' };
}

# Regenerate the UI JSONs right away, so the tree/status reflect the action
# instead of waiting for the next cron run.
sub trigger_refresh {
    my $gen = '/usr/local/sbin/gen-k8s-status.py';
    return if !-x $gen;
    eval { run_command([$gen]) };
}

my %kind_resource = (
    Deployment  => 'deployment',
    StatefulSet => 'statefulset',
    DaemonSet   => 'daemonset',
);

# kinds that can be scaled to zero (DaemonSet must run on every node)
my %kind_scalable = (
    Deployment  => 1,
    StatefulSet => 1,
);

# Same state directory as the notes: /var/lib/pve-manager/k8s. The legacy
# location under /usr/share is still read so upgrades keep the saved size.
my $desired_file = "$notes_dir/desired.json";
my $desired_legacy = '/usr/share/pve-manager/js/k8s/desired.json';

sub read_desired_state {
    for my $filename ($desired_file, $desired_legacy) {
        my $data = eval { decode_json(file_get_contents($filename, 1024 * 1024)) };
        return $data if $data && ref($data) eq 'HASH';
    }
    return {};
}

# Remember the last non-zero replica count so Start can restore it.
sub save_desired {
    my ($appid, $replicas) = @_;
    return if !defined($replicas) || $replicas <= 0;
    my $state = read_desired_state();
    $state->{$appid} = $replicas;
    mkdir $notes_dir if !-d $notes_dir;
    PVE::Tools::file_set_contents($desired_file, encode_json($state), 0644);
}

# UPID ids cannot contain ':' or '/'. Keep the readable app identity in the
# task id while satisfying PVE::UPID's parser (e.g. kube-system-coredns).
sub k8s_task_id {
    my ($appid) = @_;
    my $id = $appid;
    $id =~ s/[^A-Za-z0-9_.-]+/-/g;
    return $id;
}

# Resolve the appid to a laundered namespace + "<resource>/<name>" target for
# the mutation endpoints (scale/rollout family).
sub mutable_target {
    my ($appid) = @_;
    my $app = app_from_id($appid);
    raise_param_exc({ appid => 'Kubernetes application not found' }) if !$app;
    my $res = $kind_resource{ $app->{kind} // '' }
        or raise_param_exc({ appid => "kind '$app->{kind}' does not support this action" });
    my $ns = launder($app->{namespace}, 'namespace');
    my $name = launder($app->{name}, 'name');
    return ($ns, $app, "$res/$name");
}

# Shared runner for the context-menu actions: permission check, laundered
# scope and an immediate refresh of the UI data files.
# Every action runs as a REAL PVE task (fork_worker): the UPID lands in the
# node Task History, in the cluster-wide task list and in the cluster log
# ("starting task"/"end task") together with every other Proxmox activity --
# no separate history is kept for Kubernetes.
sub run_app_action {
    my ($param, $cmd, $flags, $dtype) = @_;
    check_modify($param->{node});
    my ($ns, $app, $target) = mutable_target($param->{appid});
    my $rpcenv = PVE::RPCEnvironment::get();
    my $authuser = $rpcenv->get_user();
    my $appid = $param->{appid};
    my $taskid = k8s_task_id($appid);
    my $realcmd = sub {
        my ($upid) = @_;
        print "k8sapp $dtype $appid\n";
        print "kubectl -n $ns @$cmd $target @$flags\n";
        my $out = run_kubectl('-n', $ns, @$cmd, $target, @$flags);
        print "$out\n" if $out;
        trigger_refresh();
        return;
    };
    return $rpcenv->fork_worker($dtype, $taskid, $authuser, $realcmd);
}

__PACKAGE__->register_method({
    name => 'index',
    path => '',
    method => 'GET',
    permissions => { user => 'all' },
    description => 'List Kubernetes applications on a node.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
        },
    },
    returns => {
        type => 'array',
        items => { type => 'object', properties => {} },
    },
    code => sub {
        my ($param) = @_;
        check_audit($param->{node});
        my $data = read_json_file($apps_file) || {};
        my @apps = map {
            {
                id => $_->{id}, appid => $_->{appid}, name => $_->{name},
                namespace => $_->{namespace}, kind => $_->{kind}, node => $_->{node},
                status => $_->{status},
                replicas => $_->{replicas} || { desired => 0, ready => 0 },
            }
        } @{ $data->{apps} || [] };
        return \@apps;
    },
});

__PACKAGE__->register_method({
    name => 'config',
    path => '{appid}/config',
    method => 'GET',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    description => 'Read Kubernetes application metadata and notes.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
        },
    },
    returns => { type => 'object', properties => {} },
    code => sub {
        my ($param) = @_;
        my $app = app_from_id($param->{appid});
        raise_param_exc({ appid => 'Kubernetes application not found' }) if !$app;
        my $notes = read_notes()->{ $param->{appid} } // '';
        # NotesView's stock load() expects result.data.description. Keep the
        # endpoint envelope identical to the regular PVE config endpoint.
        return {
            description => $notes,
            appid => $app->{appid},
            name => $app->{name},
            namespace => $app->{namespace},
        };
    },
});

__PACKAGE__->register_method({
    name => 'update_config',
    path => '{appid}/config',
    method => 'PUT',
    # Notes live in /var/lib/pve-manager (root-owned state dir): reroute the
    # PUT through pvedaemon like the guest config updates do. Without this
    # the request runs as www-data in the pveproxy worker and file_set_contents
    # fails with "unable to open file ... - Permission denied (500)".
    protected => 1,
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    description => 'Update Kubernetes application notes.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
            description => {
                type => 'string',
                maxLength => 8 * 1024,
                optional => 1,
                description => 'Notes (Markdown), same field the guests use.',
            },
        },
    },
    returns => { type => 'null' },
    code => sub {
        my ($param) = @_;
        my $app = app_from_id($param->{appid});
        raise_param_exc({ appid => 'Kubernetes application not found' }) if !$app;
        my $notes = read_notes();
        if (defined($param->{description}) && $param->{description} ne '') {
            $notes->{ $param->{appid} } = $param->{description};
        } else {
            delete $notes->{ $param->{appid} };
        }
        write_notes($notes);
        # Same audit trail the guest config updates leave in the cluster log.
        my $rpcenv = PVE::RPCEnvironment::get();
        PVE::Cluster::log_msg('info', $rpcenv->get_user(),
            "k8sapp update notes $param->{appid}");
        return undef;
    },
});

__PACKAGE__->register_method({
    name => 'log',
    path => '{appid}/log',
    method => 'GET',
    protected => 1,
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Console']] },
    description => 'Read the selected Kubernetes pod log.',
    proxyto => 'node',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
            pod => { type => 'string', description => 'Pod name.' },
            container => { type => 'string', optional => 1, description => 'Container name.' },
            tailLines => { type => 'integer', minimum => 1, maximum => 10000, optional => 1, default => 500 },
        },
    },
    returns => {
        type => 'array', items => { type => 'object', properties => {
            n => { type => 'integer' }, t => { type => 'string' },
        }},
    },
    code => sub {
        my ($param) = @_;
        check_console($param->{node});
        my $app = app_from_id($param->{appid});
        raise_param_exc({ appid => 'Kubernetes application not found' }) if !$app;
        my $allowed = 0;
        for my $pod (@{ $app->{pods} || [] }) {
            if (($pod->{name} // '') eq $param->{pod}) { $allowed = 1; last; }
        }
        raise_param_exc({ pod => 'Pod does not belong to this application' }) if !$allowed;

        # pvedaemon roda com taint mode (-T): validar e "lavar" tudo que vai
        # para exec(), como o proprio PVE faz nos handlers de Qemu/LXC.
        my $namespace = launder($app->{namespace}, 'appid');
        my $podname = launder($param->{pod}, 'pod');
        my $tail = $param->{tailLines} // 500;
        $tail =~ m/^(\d+)$/ or raise_param_exc({ tailLines => 'invalid number' });
        $tail = $1;

        my @args = ('logs', '-n', $namespace, $podname, '--tail', $tail);
        if (defined($param->{container}) && $param->{container} ne '') {
            my $container = launder($param->{container}, 'container');
            push @args, ('-c', $container);
        }
        my @lines = split(/\n/, run_kubectl(@args), -1);
        pop @lines if @lines && $lines[-1] eq '';
        my $n = 1;
        return [ map { { n => $n++, t => $_ } } @lines ];
    },
});

# ---------------------------------------------------------------- actions
# The Kubernetes equivalents of the guest context menu. Every action is a
# declarative kubectl call on the workload; nothing touches the host.

__PACKAGE__->register_method({
    name => 'termproxy',
    path => '{appid}/termproxy',
    method => 'POST',
    protected => 1,
    proxyto => 'node',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Console']] },
    description => 'Creates a TCP proxy connection to a pod shell.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
            pod => { type => 'string', description => 'Pod name.' },
            container => { type => 'string', optional => 1, description => 'Container name.' },
        },
    },
    returns => {
        additionalProperties => 0,
        properties => {
            user => { type => 'string' },
            ticket => { type => 'string' },
            port => { type => 'integer' },
            upid => { type => 'string' },
        },
    },
    code => sub {
        my ($param) = @_;
        check_console($param->{node});
        my $app = app_from_id($param->{appid});
        raise_param_exc({ appid => 'Kubernetes application not found' }) if !$app;
        my ($allowed, $podstate) = (0, '');
        for my $pod (@{ $app->{pods} || [] }) {
            if (($pod->{name} // '') eq $param->{pod}) {
                $allowed = 1;
                $podstate = $pod->{status} // '';
                last;
            }
        }
        raise_param_exc({ pod => 'Pod does not belong to this application' }) if !$allowed;
        raise_param_exc({ pod => "pod is not running (status: $podstate)" })
            if lc($podstate) ne 'running';
        return start_termproxy($param, $app, $param->{pod}, $param->{container});
    },
});

__PACKAGE__->register_method({
    name => 'vncwebsocket',
    path => '{appid}/vncwebsocket',
    method => 'GET',
    permissions => {
        description => "You also need to pass a valid ticket (vncticket).",
        check => ['perm', '/nodes/{node}', ['Sys.Console']],
    },
    description => "Opens a websocket for VNC traffic.",
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
            vncticket => {
                description => "Ticket from previous call to termproxy.",
                type => 'string',
                maxLength => 512,
            },
            port => {
                description => "Port number returned by previous termproxy call.",
                type => 'integer',
                minimum => 5900,
                maximum => 5999,
            },
        },
    },
    returns => {
        type => 'object',
        properties => {
            port => { type => 'string' },
        },
    },
    code => sub {
        my ($param) = @_;
        check_console($param->{node});
        my $rpcenv = PVE::RPCEnvironment::get();
        my $authuser = $rpcenv->get_user();
        my $authpath = console_authpath($param->{node}, $param->{appid});
        PVE::AccessControl::verify_vnc_ticket(
            $param->{vncticket}, $authuser, $authpath, $param->{port});
        return { port => $param->{port} };
    },
});

__PACKAGE__->register_method({
    name => 'scale',
    path => '{appid}/scale',
    method => 'POST',
    protected => 1,
    proxyto => 'node',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    description => 'Scale the Kubernetes application to a replica count.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
            replicas => { type => 'integer', minimum => 0, maximum => 1000,
                description => 'Desired replica count.' },
        },
    },
    returns => action_returns(),
    code => sub {
        my ($param) = @_;
        check_modify($param->{node});
        my ($ns, $app, $target) = mutable_target($param->{appid});
        raise_param_exc({ appid => "kind '$app->{kind}' cannot be scaled" })
            if !$kind_scalable{ $app->{kind} // '' };
        my $replicas = $param->{replicas};
        $replicas = launder("$replicas", 'replicas');
        save_desired($param->{appid}, $replicas);
        my $rpcenv = PVE::RPCEnvironment::get();
        my $authuser = $rpcenv->get_user();
        my $appid = $param->{appid};
        my $taskid = k8s_task_id($appid);
        my $realcmd = sub {
            my ($upid) = @_;
            print "k8sapp scale $appid --replicas=$replicas\n";
            my $out = run_kubectl('-n', $ns, 'scale', $target, "--replicas=$replicas");
            print "$out\n" if $out;
            trigger_refresh();
            return;
        };
        return $rpcenv->fork_worker('k8sscale', $taskid, $authuser, $realcmd);
    },
});

__PACKAGE__->register_method({
    name => 'start',
    path => '{appid}/start',
    method => 'POST',
    protected => 1,
    proxyto => 'node',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    description => 'Start the application, restoring its previous replica count.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
        },
    },
    returns => action_returns(),
    code => sub {
        my ($param) = @_;
        check_modify($param->{node});
        my ($ns, $app, $target) = mutable_target($param->{appid});
        raise_param_exc({ appid => "kind '$app->{kind}' cannot be scaled" })
            if !$kind_scalable{ $app->{kind} // '' };
        # desired.json is file data (tainted under -T): launder before exec.
        my $replicas = int(read_desired_state()->{ $param->{appid} } // 1) || 1;
        $replicas = launder("$replicas", 'replicas');
        my $rpcenv = PVE::RPCEnvironment::get();
        my $authuser = $rpcenv->get_user();
        my $appid = $param->{appid};
        my $taskid = k8s_task_id($appid);
        my $realcmd = sub {
            my ($upid) = @_;
            print "k8sapp start $appid --replicas=$replicas\n";
            my $out = run_kubectl('-n', $ns, 'scale', $target, "--replicas=$replicas");
            print "$out\n" if $out;
            trigger_refresh();
            return;
        };
        return $rpcenv->fork_worker('k8sstart', $taskid, $authuser, $realcmd);
    },
});

__PACKAGE__->register_method({
    name => 'stop',
    path => '{appid}/stop',
    method => 'POST',
    protected => 1,
    proxyto => 'node',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    description => 'Stop the application by scaling it to zero replicas.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
        },
    },
    returns => action_returns(),
    code => sub {
        my ($param) = @_;
        check_modify($param->{node});
        my ($ns, $app, $target) = mutable_target($param->{appid});
        raise_param_exc({ appid => "kind '$app->{kind}' cannot be scaled" })
            if !$kind_scalable{ $app->{kind} // '' };
        # remember the current size, so Start can bring it back
        save_desired($param->{appid}, ($app->{replicas} || {})->{desired});
        my $rpcenv = PVE::RPCEnvironment::get();
        my $authuser = $rpcenv->get_user();
        my $appid = $param->{appid};
        my $taskid = k8s_task_id($appid);
        my $realcmd = sub {
            my ($upid) = @_;
            print "k8sapp stop $appid --replicas=0\n";
            my $out = run_kubectl('-n', $ns, 'scale', $target, '--replicas=0');
            print "$out\n" if $out;
            trigger_refresh();
            return;
        };
        return $rpcenv->fork_worker('k8sstop', $taskid, $authuser, $realcmd);
    },
});

__PACKAGE__->register_method({
    name => 'restart',
    path => '{appid}/restart',
    method => 'POST',
    protected => 1,
    proxyto => 'node',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    description => 'Rolling restart of the Kubernetes application.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
        },
    },
    returns => action_returns(),
    code => sub {
        my ($param) = @_;
        return run_app_action($param, ['rollout', 'restart'], [], 'k8srestart');
    },
});

__PACKAGE__->register_method({
    name => 'rollout_undo',
    path => '{appid}/rollback',
    method => 'POST',
    protected => 1,
    proxyto => 'node',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    description => 'Roll the application back to its previous revision.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
        },
    },
    returns => action_returns(),
    code => sub {
        my ($param) = @_;
        return run_app_action($param, ['rollout', 'undo'], [], 'k8srollback');
    },
});

__PACKAGE__->register_method({
    name => 'rollout_pause',
    path => '{appid}/pause',
    method => 'POST',
    protected => 1,
    proxyto => 'node',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    description => 'Pause the rollout of the Kubernetes application.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
        },
    },
    returns => action_returns(),
    code => sub {
        my ($param) = @_;
        return run_app_action($param, ['rollout', 'pause'], [], 'k8spause');
    },
});

__PACKAGE__->register_method({
    name => 'rollout_resume',
    path => '{appid}/resume',
    method => 'POST',
    protected => 1,
    proxyto => 'node',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    description => 'Resume a paused rollout of the Kubernetes application.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
        },
    },
    returns => action_returns(),
    code => sub {
        my ($param) = @_;
        return run_app_action($param, ['rollout', 'resume'], [], 'k8sresume');
    },
});

__PACKAGE__->register_method({
    name => 'rollout_status',
    path => '{appid}/rollout',
    method => 'GET',
    protected => 1,
    proxyto => 'node',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    description => 'Rollout status and revision history of the application.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
        },
    },
    returns => { type => 'object', properties => {} },
    code => sub {
        my ($param) = @_;
        check_audit($param->{node});
        my ($ns, $app, $target) = mutable_target($param->{appid});
        my $status = eval { run_kubectl('-n', $ns, 'rollout', 'status', $target, '--timeout=3s') };
        $status = $@ ? "$@" : $status;
        my $history = eval { run_kubectl('-n', $ns, 'rollout', 'history', $target) } // '';
        $status = '' if !defined($status);
        chomp($status);
        return {
            status => $status // '',
            history => $history,
            kind => $app->{kind},
            name => $app->{name},
            namespace => $app->{namespace},
        };
    },
});

__PACKAGE__->register_method({
    name => 'delete_pod',
    path => '{appid}/deletepod',
    method => 'POST',
    protected => 1,
    proxyto => 'node',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    description => 'Delete (recreate) a single pod of the application.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
            pod => { type => 'string', description => 'Pod name.' },
        },
    },
    returns => action_returns(),
    code => sub {
        my ($param) = @_;
        check_modify($param->{node});
        my $app = app_from_id($param->{appid});
        raise_param_exc({ appid => 'Kubernetes application not found' }) if !$app;
        my $allowed = 0;
        for my $pod (@{ $app->{pods} || [] }) {
            if (($pod->{name} // '') eq $param->{pod}) { $allowed = 1; last; }
        }
        raise_param_exc({ pod => 'Pod does not belong to this application' }) if !$allowed;
        my $ns = launder($app->{namespace}, 'appid');
        my $podname = launder($param->{pod}, 'pod');
        my $rpcenv = PVE::RPCEnvironment::get();
        my $authuser = $rpcenv->get_user();
        my $appid = $param->{appid};
        my $taskid = k8s_task_id($appid);
        my $realcmd = sub {
            my ($upid) = @_;
            print "k8sapp deletepod $appid pod $podname\n";
            my $out = run_kubectl('-n', $ns, 'delete', 'pod', $podname);
            print "$out\n" if $out;
            trigger_refresh();
            return;
        };
        return $rpcenv->fork_worker('k8sdeletepod', $taskid, $authuser, $realcmd);
    },
});

__PACKAGE__->register_method({
    name => 'describe',
    path => '{appid}/describe',
    method => 'GET',
    protected => 1,
    proxyto => 'node',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    description => 'kubectl describe / get -o yaml of the application workload.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
            pod => { type => 'string', description => 'Restricts describe to the given pod.', optional => 1 },
            format => { type => 'string', enum => ['describe', 'yaml'], optional => 1,
                default => 'describe' },
        },
    },
    returns => {
        type => 'array', items => { type => 'object', properties => {
            n => { type => 'integer' }, t => { type => 'string' },
        }},
    },
    code => sub {
        my ($param) = @_;
        check_audit($param->{node});
        my ($ns, $app, $target) = mutable_target($param->{appid});
        my $format = $param->{format} // 'describe';
        my @args;
        if (defined($param->{pod}) && $param->{pod} ne '') {
            # POC k8s: describe/yaml de um pod especifico da aplicacao (menu do
            # pod na arvore). Valida que o pod pertence a app antes do kubectl.
            my $appdata = app_from_id($param->{appid});
            raise_param_exc({ appid => 'Kubernetes application not found' }) if !$appdata;
            my $allowed = 0;
            for my $p (@{ $appdata->{pods} || [] }) {
                if (($p->{name} // '') eq $param->{pod}) { $allowed = 1; last; }
            }
            raise_param_exc({ pod => 'Pod does not belong to this application' }) if !$allowed;
            my $podname = launder($param->{pod}, 'pod');
            @args = $format eq 'yaml'
                ? ('get', 'pod', $podname, '-o', 'yaml')
                : ('describe', 'pod', $podname);
        } else {
            @args = $format eq 'yaml'
                ? ('get', $target, '-o', 'yaml')
                : ('describe', $target);
        }
        my @lines = split(/\n/, run_kubectl('-n', $ns, @args), -1);
        pop @lines if @lines && $lines[-1] eq '';
        my $n = 1;
        return [ map { { n => $n++, t => $_ } } @lines ];
    },
});

__PACKAGE__->register_method({
    name => 'tasks',
    path => '{appid}/tasks',
    method => 'GET',
    protected => 1,
    proxyto => 'node',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    description => 'Read the Proxmox task history for one Kubernetes application.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
            start => { type => 'integer', minimum => 0, default => 0, optional => 1 },
            limit => { type => 'integer', minimum => 0, default => 50, optional => 1 },
            source => { type => 'string', enum => ['archive', 'active', 'all'], default => 'archive', optional => 1 },
            since => { type => 'integer', optional => 1 },
            until => { type => 'integer', optional => 1 },
            statusfilter => { type => 'string', optional => 1 },
            # sent by proxmoxNodeTasks' own filter toolbar; must be declared
            # (additionalProperties => 0) or the grid breaks when used.
            userfilter => { type => 'string', optional => 1 },
            typefilter => { type => 'string', optional => 1 },
        },
    },
    returns => {
        type => 'array',
        items => { type => 'object', properties => {} },
    },
    code => sub {
        my ($param) = @_;
        # permissions => check already required Sys.Audit on this node to
        # reach here (same gate as config/log/describe below); call the
        # file's own helper too, matching its established style.
        check_audit($param->{node});
        my $app = app_from_id($param->{appid});
        raise_param_exc({ appid => 'Kubernetes application not found' }) if !$app;

        # The native /nodes/{node}/tasks endpoint only has a VMID filter.
        # Kubernetes tasks use their readable appid in the UPID id field, so
        # read the same PVE task files and apply the app identity here. This
        # keeps the native task model/columns while preventing other guests,
        # nodes or Kubernetes applications from leaking into this panel.
        my $start = $param->{start} // 0;
        my $limit = $param->{limit} // 50;
        my $source = $param->{source} // 'archive';
        my $since = $param->{since};
        my $until = $param->{until};
        my $statusfilter = defined($param->{statusfilter})
            ? { map { lc($_) => 1 } split_list($param->{statusfilter}) }
            : undef;
        my $userfilter = $param->{userfilter};
        my $typefilter = $param->{typefilter};
        # The UPID id of every k8s task is this application's identity, and
        # every k8s task type starts with 'k8s' (k8sscale/k8sstart/...).
        my $task_id = k8s_task_id($param->{appid});
        my $matched = 0;
        my $result = [];

        my $accept = sub {
            my ($task) = @_;
            return if $userfilter && ($task->{user} // '') !~ /\Q$userfilter\E/i;
            return if $typefilter && ($task->{type} // '') ne $typefilter;
            return if !$task->{type} || $task->{type} !~ /^k8s/;
            return if !defined($task->{id}) || $task->{id} ne $task_id;
            # The permissions gate above (Sys.Audit on the node) is also PVE's
            # task-visibility rule for auditors: they see every node task.
            # Users without Sys.Audit never reach this endpoint (nor the panel).
            return if defined($since) && $task->{starttime} < $since;
            return if defined($until) && $task->{starttime} > $until;
            if ($statusfilter) {
                my $status = PVE::Tools::upid_normalize_status_type($task->{status});
                return if !$statusfilter->{$status};
            }
            # $matched counts every task of THIS application (the grid needs
            # the real total for its scrollbar); $start/$limit page over it.
            return if $matched++ < $start;
            return if $limit <= 0;
            $limit--;
            push @$result, $task;
            return;
        };

        my $parse_line = sub {
            my ($line) = @_;
            return if $line !~ /^(\S+)(\s([0-9A-Za-z]{8})(\s(\S.*))?)?$/;
            my ($upid, $endhex, $status) = ($1, $3, $5);
            my $task = PVE::Tools::upid_decode($upid, 1);
            return if !$task;
            $task->{upid} = $upid;
            $task->{endtime} = hex($endhex) if $endhex;
            $task->{status} = $status if $status;
            $accept->($task);
        };

        my $active = sub {
            my $tasks = eval { PVE::INotify::read_file('active') } || [];
            for my $task (@$tasks) {
                next if $task->{saved};
                $task->{status} = 'RUNNING' if !$task->{status};
                $accept->($task);
            }
        };
        $active->() if $source eq 'active' || $source eq 'all';

        if ($source ne 'active' && $limit > 0) {
            for my $filename ('/var/log/pve/tasks/index', '/var/log/pve/tasks/index.1') {
                my $reader = File::ReadBackwards->new($filename);
                next if !$reader;
                while (defined(my $line = $reader->readline)) {
                    $parse_line->($line);
                    last if $limit <= 0;
                }
                $reader->close();
                last if $limit <= 0;
            }
        }
        # The BufferedStore needs the real total to size its scrollbar, the
        # same attribute PVE::API2::Tasks sets.
        PVE::RPCEnvironment::get()->set_result_attrib('total', $matched);
        return $result;
    },
});

__PACKAGE__->register_method({
    name => 'rrddata',
    path => '{appid}/rrddata',
    method => 'GET',
    protected => 1,
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    description => 'Read Kubernetes application RRD statistics.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            appid => { type => 'string', description => 'Namespace:name application identifier.' },
            timeframe => { type => 'string', enum => ['hour', 'day', 'week', 'month', 'year'], optional => 1 },
            cf => { type => 'string', enum => ['AVERAGE', 'MAX'], optional => 1 },
        },
    },
    returns => { type => 'array', items => { type => 'object', properties => {} } },
    code => sub {
        my ($param) = @_;
        my $app = app_from_id($param->{appid});
        raise_param_exc({ appid => 'Kubernetes application not found' }) if !$app;
        my $data = read_json_file($history_file) || {};
        my $samples = $data->{series}{ $param->{appid} } || [];
        # history.json guarda 1 amostra/minuto (POC); recortes maiores mostram
        # tudo o que ja foi coletado, como um RRD parcialmente preenchido.
        my %tail_of = (hour => 70, day => 1440, week => 10080, month => 43200, year => 525600);
        my $tail = $tail_of{ $param->{timeframe} // 'hour' } // 1440;
        my @slice = scalar(@$samples) > $tail ? @$samples[-$tail .. -1] : @$samples;
        my @result;
        for my $s (@slice) {
            push @result, {
                time => $s->[0], cpu => $s->[1], maxcpu => $s->[2],
                mem => $s->[3], maxmem => $s->[4],
                netin => 0, netout => 0,
                pressurecpusome => 0, pressurecpufull => 0,
            };
        }
        return \@result;
    },
});

1;
