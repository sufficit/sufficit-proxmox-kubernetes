package PVE::API2::NodeK8sNet;

use strict;
use warnings;

use PVE::API2::Cluster::K8sNet;
use PVE::Exception qw(raise_param_exc);
use PVE::JSONSchema qw(get_standard_option);
use PVE::RESTHandler;
use PVE::RPCEnvironment;
use PVE::Tools qw(run_command);

use base qw(PVE::RESTHandler);

# POC k8s (k8s-poc): endpoint POR NO da rede do Kubernetes (k3s).
#
# Registrado em Nodes.pm sob /nodes/{node}/k8snet, com proxyto => 'node':
# o dispatcher do PVE encaminha a chamada para o no pedido e ela executa
# LA (leitura da unit local, interfaces locais, restart do k3s local).
#
# GET /nodes/{node}/k8snet/network -> snapshot deste no (mesmo formato do
#                                     payload local do GET de cluster).
# PUT /nodes/{node}/k8snet/network -> aplica as flags NESTE no rodando
#                                     /usr/local/sbin/k8snet-apply-node
#                                     (mesma implementacao usada pelo
#                                     fan-out do PUT de cluster).

my $APPLY_SCRIPT = '/usr/local/sbin/k8snet-apply-node';

my @NET_FLAGS = qw(cluster-cidr service-cidr flannel-iface node-ip);

sub validate_flags {
    my ($param) = @_;

    my %flags;
    for my $flag (@NET_FLAGS) {
        next if !defined($param->{$flag});
        my $v = $param->{$flag};
        if ($flag eq 'cluster-cidr' || $flag eq 'service-cidr') {
            $flags{$flag} = PVE::API2::Cluster::K8sNet::validate_cidr($v, $flag);
        } elsif ($flag eq 'flannel-iface') {
            $flags{$flag} = PVE::API2::Cluster::K8sNet::validate_iface($v, $flag);
        } else {
            $flags{$flag} = PVE::API2::Cluster::K8sNet::validate_ip($v, $flag);
        }
    }
    raise_param_exc({ body => 'no network setting supplied' }) if !%flags;
    return \%flags;
}

__PACKAGE__->register_method({
    name => 'index',
    path => '',
    method => 'GET',
    permissions => { user => 'all' },
    description => 'Per-node Kubernetes (k3s) network endpoint index.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
        },
    },
    returns => {
        type => 'array',
        items => { type => 'object', properties => {} },
        links => [{ rel => 'child', href => '{name}' }],
    },
    code => sub {
        return [{ name => 'network' }];
    },
});

__PACKAGE__->register_method({
    name => 'network',
    path => 'network',
    method => 'GET',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    proxyto => 'node',
    description => 'Read the Kubernetes (k3s) network configuration of this'
        . ' node: declared flags, effective CIDRs, interfaces, SDN vnets and'
        . ' range conflicts.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
        },
    },
    returns => { type => 'object' },
    code => sub {
        my ($param) = @_;
        return PVE::API2::Cluster::K8sNet::node_snapshot();
    },
});

__PACKAGE__->register_method({
    name => 'update',
    path => 'network',
    method => 'PUT',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    protected => 1,
    proxyto => 'node',
    description => 'Apply Kubernetes (k3s) network settings on THIS node:'
        . ' rewrite the network flags in the local k3s systemd unit and'
        . ' restart the service as a PVE task, with automatic rollback if'
        . ' the node does not become Ready again.',
    parameters => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
            'cluster-cidr' => {
                type => 'string', optional => 1,
                description => 'Pod network CIDR (k3s cluster-cidr).',
                pattern => qr/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/,
            },
            'service-cidr' => {
                type => 'string', optional => 1,
                description => 'Service network CIDR (k3s service-cidr).',
                pattern => qr/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/,
            },
            'flannel-iface' => {
                type => 'string', optional => 1,
                description => 'Interface used by the flannel backend.',
                pattern => qr/^[A-Za-z0-9][A-Za-z0-9._-]{0,14}$/,
            },
            'node-ip' => {
                type => 'string', optional => 1,
                description => 'Primary node IP advertised by k3s.',
                pattern => qr/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
            },
            restart => {
                type => 'boolean', optional => 1, default => 1,
                description => 'Restart the k3s service to apply (recommended).',
            },
        },
    },
    returns => { type => 'string' },
    code => sub {
        my ($param) = @_;

        my $rpcenv = PVE::RPCEnvironment::get();
        my $authuser = $rpcenv->get_user();
        my $flags = validate_flags($param);
        my $restart = $param->{restart} // 1;

        # UPID nao aceita '/' no campo id (PVE::UPID: [^:\s/]+) -> o nome do
        # no entra sozinho; o node ja esta no propio UPID.
        my ($node) = $param->{node} =~ m/^([A-Za-z0-9][A-Za-z0-9.-]*)$/
            or raise_param_exc({ node => 'invalid node name' });

        my @cmd = ($APPLY_SCRIPT);
        push @cmd, map { "--$_=$flags->{$_}" } grep { defined($flags->{$_}) } @NET_FLAGS;
        push @cmd, '--no-restart' if !$restart;

        my $realcmd = sub {
            my ($upid) = @_;
            print "applying k3s network flags on this node ($node):\n";
            run_command(\@cmd,
                outfunc => sub { print shift, "\n" },
                errfunc => sub { print shift, "\n" });
            print "done\n";
            return;
        };

        return $rpcenv->fork_worker('k8snet', $node, $authuser, $realcmd);
    },
});

1;
