package PVE::API2::Cluster::K8sNet;

use strict;
use warnings;

use JSON::PP qw(decode_json encode_json);
use PVE::Cluster;
use PVE::Exception qw(raise_param_exc);
use PVE::INotify;
use PVE::JSONSchema qw(get_standard_option);
use PVE::RESTHandler;
use PVE::RPCEnvironment;
# ssh_info_to_command/get_ssh_info: mesmo mecanismo nativo que LXC/Qemu usam
# para alcancar outros nos do cluster (fan-out do PUT multi-no).
use PVE::SSHInfo;
use PVE::Tools qw(file_get_contents file_set_contents run_command split_list);

use base qw(PVE::RESTHandler);

# POC k8s (k8s-poc): rede do Kubernetes (k3s no host).
#
# GET  /cluster/k8snet/network  -> visao MULTI-NO: snapshot ao vivo deste host
#                                  + snapshots de todos os nos publicados no
#                                  pmxcfs, VNets SDN e conflitos de faixa
#                                  (incl. divergencia de CIDR entre servers).
# PUT  /cluster/k8snet/network  -> FAN-OUT: grava as flags de rede na unit
#                                  systemd do k3s de CADA no alvo (todos, por
#                                  padrao; param nodes restringe) e reinicia o
#                                  servico como task PVE, com pre-flight por
#                                  no antes de qualquer mudanca e rollback
#                                  automatico se um no nao voltar a Ready.
#
# A unit e editada cirurgicamente: apenas as 4 flags de rede sao
# adicionadas/removidas; o restante do bloco ExecStart fica intacto.
# O backup .bak-k8snet e criado na primeira alteracao e preservado, de modo
# que o rollback restaura sempre a configuracao anterior a POC.

my $K3S_BIN = '/usr/local/bin/k3s';
# Script aplicador instalado pelo patch_ui.py em TODOS os nos: encapsula
# apply_node_net_flags() para que o PUT de cluster (e o PUT per-node) usem
# exatamente o mesmo codigo localmente e via ssh.
my $APPLY_SCRIPT = '/usr/local/sbin/k8snet-apply-node';
# Seam de teste: K8SNET_UNIT_PATH permite exercitar a reescrita da unit num
# arquivo temporario (ex.: no host, antes de aplicar de verdade).
my $K3S_UNIT = $ENV{K8SNET_UNIT_PATH} || '/etc/systemd/system/k3s.service';
my $FLANNEL_CONF = '/var/lib/rancher/k3s/agent/etc/flannel/net-conf.json';
my $SDN_RUNNING = '/etc/pve/sdn/.running-config';

my $DEFAULT_CLUSTERCIDR = '10.42.0.0/16';
my $DEFAULT_SERVICECIDR = '10.43.0.0/16';

my @NET_FLAGS = qw(cluster-cidr service-cidr flannel-iface node-ip);

my $cidr_re = qr/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

sub validate_cidr {
    my ($cidr, $what) = @_;
    if ($cidr =~ $cidr_re) {
        my @octets = ($1, $2, $3, $4);
        my $mask = $5;
        die "invalid CIDR in '$what': octet out of range\n"
            if grep { $_ > 255 } @octets;
        die "invalid prefix in '$what': /$mask\n" if $mask < 8 || $mask > 32;
        # devolve a partir das capturas do regex: remove o taint (os valores
        # viram argumento de comando no apply multi-no, e o pvedaemon roda
        # com -T)
        return "$1.$2.$3.$4/$mask";
    } else {
        die "invalid CIDR format in '$what' (expected a.b.c.d/nn)\n";
    }
}

sub validate_ip {
    my ($ip, $what) = @_;
    $ip =~ m/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
        or die "invalid IP format in '$what'\n";
    die "invalid IP in '$what': octet out of range\n" if grep { $_ > 255 } ($1, $2, $3, $4);
    return "$1.$2.$3.$4";
}

sub validate_iface {
    my ($iface, $what) = @_;
    $iface =~ m/^([A-Za-z0-9][A-Za-z0-9._-]{0,14})$/
        or die "invalid interface name in '$what'\n";
    return $1;
}

# ---- leitura da configuracao declarada -------------------------------------

sub read_unit_lines {
    return () if !-f $K3S_UNIT;
    open(my $fh, '<', $K3S_UNIT) or return ();
    my @lines = <$fh>;
    close($fh);
    chomp @lines;
    return @lines;
}

# Quebra o bloco ExecStart (linhas de continuacao do systemd) em tokens argv.
sub parse_execstart_tokens {
    my (@lines) = @_;
    my @tokens;
    for my $line (@lines) {
        my $s = $line;
        # a barra de continuacao do systemd fica DEPOIS de um espaco (ex.:
        # "'--flannel-iface=eno1' \"); remove-la antes de aparar espacos,
        # senao ela bloqueia o match final de "s/^'(.*)'$/.../" abaixo e o
        # token sobrevive com a aspa/backslash grudados.
        $s =~ s/\\\s*$//;
        $s =~ s/\s+$//;
        $s =~ s/^\s+//;
        next if $s eq '';
        next if $s =~ m/^ExecStart=\S+$/;    # "ExecStart=/bin" sem argumentos
        $s =~ s/^ExecStart=\S+\s+//;         # "ExecStart=/bin arg..."
        $s =~ s/^'(.*)'$/$1/;
        $s =~ s/^"(.*)"$/$1/;
        next if $s eq '';
        push @tokens, $s;
    }
    return @tokens;
}

sub execstart_block_range {
    my (@lines) = @_;
    my $start;
    for my $i (0 .. $#lines) {
        if ($lines[$i] =~ m/^ExecStart=/) { $start = $i; last; }
    }
    return if !defined($start);
    my $end = $start;
    # avanca enquanto a linha atual TERMINA com barra (continuacao systemd);
    # quando para, $end e a primeira linha sem barra -- que FECHA o bloco
    # (ultima linha de argumentos, ex.: "'--flannel-iface=eno1'").
    $end++ while $end < $#lines && $lines[$end] =~ m/\\$/;
    # se essa linha de fechamento for vazia (separador antes da proxima
    # secao), devolve-a ao tail preservando o espaco visual.
    $end-- if $end > $start && $lines[$end] =~ m/^\s*$/;
    return ($start, $end);
}

# Flags de rede declaradas na unit (argv do bloco ExecStart).
sub read_unit_net_args {
    my %args;
    my @lines = read_unit_lines();
    return \%args if !@lines;
    my ($start, $end) = execstart_block_range(@lines);
    return \%args if !defined($start);
    for my $t (parse_execstart_tokens(@lines[$start .. $end])) {
        for my $flag (@NET_FLAGS) {
            $args{$flag} = $1 if $t =~ m/^--$flag=(.+)$/;
        }
    }
    return \%args;
}

# Config.yaml legado (somente as chaves planas que a POC conhece).
sub read_config_yaml_args {
    my %args;
    return \%args if !-f '/etc/rancher/k3s/config.yaml';
    my $raw = eval { file_get_contents('/etc/rancher/k3s/config.yaml') };
    return \%args if !$raw;
    while ($raw =~ m/^\s*(cluster-cidr|service-cidr|flannel-iface|node-ip):\s*(\S+)\s*$/mg) {
        $args{$1} = $2;
    }
    return \%args;
}

sub read_flannel_conf {
    my $raw = eval { file_get_contents($FLANNEL_CONF, 64 * 1024) };
    return {} if !$raw;
    my $data = eval { decode_json($raw) };
    return {} if ref($data) ne 'HASH';
    return $data;
}

# ---- estado live ------------------------------------------------------------

sub live_interfaces {
    my @out;
    run_command(['ip', '-o', '-4', 'addr', 'show'],
        outfunc => sub { push @out, shift }, errfunc => sub {});
    my @res;
    for my $line (@out) {
        # "2: eno1    inet 192.0.2.10/24 brd ..."
        next if $line !~ m/^\s*\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/;
        push @res, { name => $1, ip => $2, prefix => int($3) };
    }
    return \@res;
}

# Interfaces consequencia do proprio CNI (nao sao candidatos a conflito).
sub is_cni_interface {
    my ($name) = @_;
    return 1
        if $name =~ m/^(flannel|cilium_vxlan|vxlan-calico)/
        || $name =~ m/^flannel\./
        || $name =~ m/^cali[a-f0-9]/
        || $name =~ m/^veth/
        || $name eq 'cni0'
        || $name eq 'kube-ipvs0';
    return 0;
}

sub sdn_vnets_flat {
    my ($interfaces) = @_;
    my $have_sdn = eval {
        require PVE::Network::SDN::Zones;
        require PVE::Network::SDN::Vnets;
        require PVE::Network::SDN::Subnets;
        1;
    };
    return () if !$have_sdn;

    my $iface_by_name = { map { $_->{name} => 1 } @$interfaces };
    my $nodename = eval { PVE::INotify::nodename() } // '';
    my @out;
    eval {
        my $zones = PVE::Network::SDN::Zones::config();
        my $vnets = PVE::Network::SDN::Vnets::config();
        my $subnets = PVE::Network::SDN::Subnets::config();
        my $running = -f $SDN_RUNNING;

        for my $vnetid (sort keys %{ $vnets->{ids} // {} }) {
            my $vnet = $vnets->{ids}->{$vnetid};
            my $zoneid = $vnet->{zone} // '';
            my $zone = $zones->{ids}->{$zoneid} // {};
            # zonas podem restringir nodes (ex.: "nodes pve1"): so listar
            # vnets validas para ESTE no
            if (ref($zone->{nodes}) eq 'HASH' && %{$zone->{nodes}}) {
                next if !$zone->{nodes}->{$nodename};
            }
            my $entry = {
                vnet => $vnetid,
                zone => $zoneid,
                zone_type => $zone->{type} // '',
                alias => $vnet->{alias} // '',
                applied => $running ? 1 : 0,
                up => $iface_by_name->{$vnetid} ? 1 : 0,
                cidr => '',
                gateway => '',
                snat => 0,
                'dhcp-range' => '',
            };
            my @subnets;
            for my $subid (sort keys %{ $subnets->{ids} // {} }) {
                my $sub = eval { PVE::Network::SDN::Subnets::sdn_subnets_config($subnets, $subid, 1) };
                next if !$sub || ($sub->{vnet} // '') ne $vnetid;
                push @subnets, $sub;
            }
            if (@subnets) {
                # POC: a UI mostra a primeira subnet do vnet.
                my $sub = $subnets[0];
                $entry->{cidr} = $sub->{cidr} // '';
                $entry->{gateway} = $sub->{gateway} // '';
                $entry->{snat} = $sub->{snat} ? 1 : 0;
                if (ref($sub->{'dhcp-range'}) eq 'ARRAY' && @{ $sub->{'dhcp-range'} }) {
                    $entry->{'dhcp-range'} = join(' ', @{ $sub->{'dhcp-range'} });
                }
            }
            push @out, $entry;
        }
    };
    return @out;
}

# Sobreposicao de faixas em Perl puro (sem depender de Net::IP): converte os
# dois CIDRs em intervalos inteiros e compara os limites.
sub ip_to_int {
    my ($ip) = @_;
    my @o = split(m/\./, $ip // '');
    return undef if @o != 4 || grep { $_ !~ m/^\d+$/ || $_ > 255 } @o;
    return (int($o[0]) << 24) | (int($o[1]) << 16) | (int($o[2]) << 8) | int($o[3]);
}

sub cidr_range {
    my ($cidr) = @_;
    return if !defined($cidr);
    my ($net, $mask) = split(m{/}, $cidr, 2);
    return if !defined($mask) || $mask !~ m/^\d+$/ || $mask > 32;
    my $n = ip_to_int($net);
    return if !defined $n;
    my $hostbits = 32 - int($mask);
    my $size = $hostbits >= 32 ? 0xFFFFFFFF : ((1 << $hostbits) - 1);
    return ($n & (0xFFFFFFFF ^ $size), $n | $size);
}

sub ip_overlaps {
    my ($a, $b) = @_;
    my @ra = cidr_range($a);
    my @rb = cidr_range($b);
    return undef if !@ra || !@rb;
    return ($ra[0] <= $rb[1] && $rb[0] <= $ra[1]) ? 1 : 0;
}

sub compute_conflicts {
    my ($k8s_cidrs, $interfaces, $sdn_vnets) = @_;
    my @conflicts;

    for my $c (@$k8s_cidrs) {
        next if !$c->{cidr};
        for my $if (@$interfaces) {
            next if is_cni_interface($if->{name});
            my $net = "$if->{ip}/$if->{prefix}";
            next if !ip_overlaps($c->{cidr}, $net);
            push @conflicts, {
                cidr => $c->{cidr},
                kind => ($c->{kind} // ''),
                against => $net,
                against_kind => 'interface',
                detail => "interface $if->{name} ($net)",
            };
        }
        for my $v (@$sdn_vnets) {
            next if !$v->{cidr};
            next if !ip_overlaps($c->{cidr}, $v->{cidr});
            push @conflicts, {
                cidr => $c->{cidr},
                kind => ($c->{kind} // ''),
                against => $v->{cidr},
                against_kind => 'sdn-subnet',
                detail => "SDN vnet $v->{vnet} ($v->{cidr})",
            };
        }
    }
    return \@conflicts;
}

# ---- snapshot multi-nó -------------------------------------------------------

# A leitura é compartilhada com o endpoint per-node. Manter esta função sem
# parâmetros é importante: proxyto=>node já seleciona o host remoto no
# dispatcher, portanto tudo abaixo continua lendo a unit e o kernel LOCAIS.
sub node_snapshot {
    my $unit_args = read_unit_net_args();
    my $yaml_args = read_config_yaml_args();
    my $flannel = read_flannel_conf();
    my $interfaces = live_interfaces();

    my $declared = {};
    for my $flag (@NET_FLAGS) {
        $declared->{$flag} = $unit_args->{$flag} // $yaml_args->{$flag};
    }

    my $effective_podcidr = $flannel->{Network}
        || $declared->{'cluster-cidr'}
        || $DEFAULT_CLUSTERCIDR;
    my $servicecidr = $declared->{'service-cidr'} || $DEFAULT_SERVICECIDR;
    my $sdn_vnets = [ sdn_vnets_flat($interfaces) ];
    my $conflicts = compute_conflicts(
        [
            { cidr => $effective_podcidr, kind => 'pod' },
            { cidr => $servicecidr, kind => 'service' },
        ],
        $interfaces,
        $sdn_vnets,
    );

    return {
        declared => $declared,
        defaults => {
            'cluster-cidr' => $DEFAULT_CLUSTERCIDR,
            'service-cidr' => $DEFAULT_SERVICECIDR,
        },
        effective => {
            podcidr => $effective_podcidr,
            servicecidr => $servicecidr,
            backend => $flannel->{Backend}->{Type} // 'vxlan',
            'flannel-iface' => $declared->{'flannel-iface'} // '(auto)',
            'node-ip' => $declared->{'node-ip'} // '',
        },
        unit => $K3S_UNIT,
        interfaces => $interfaces,
        sdn => {
            applied => (-f $SDN_RUNNING) ? 1 : 0,
            vnets => $sdn_vnets,
        },
        conflicts => $conflicts,
    };
}

# Publica o snapshot deste host no status KV do pmxcfs. Isso permite ao
# endpoint cluster-level consultar todos os nós sem executar shell remoto nem
# reimplementar autenticação entre pveproxy/pvedaemon. O publicador é chamado
# pelo cron root e o GET cluster só lê, nunca executa comando no peer.
sub publish_node_snapshot {
    my ($snapshot) = @_;
    my $nodename = eval { PVE::INotify::nodename() } // 'unknown';
    my $payload = encode_json({
        version => 1,
        node => $nodename,
        timestamp => time(),
        snapshot => $snapshot,
    });
    PVE::Cluster::broadcast_node_kv('k8snet-network', $payload);
}

# ---- agregacao multi-no ------------------------------------------------------

# Combina o snapshot local com os snapshots publicados pelos proprios nos no
# KV do pmxcfs (key k8snet-network). $kv e o hash {node => json} de
# PVE::Cluster::get_node_kv; separado como parametro para poder ser exercitado
# por testes sem pmxcfs. Emite conflitos de DIVERGENCIA quando servidores k3s
# frescos reportam cluster-cidr/service-cidr diferentes (esses CIDRs sao
# globais no k3s; servers com valores distintos nao formam um cluster sao).
sub cluster_aggregate {
    my ($local_snap, $kv) = @_;

    my $nodename = eval { PVE::INotify::nodename() } // 'unknown';
    my $now = time();

    my %snaps;
    for my $node (sort keys %{ $kv // {} }) {
        my $doc = eval { decode_json($kv->{$node}) };
        next if ref($doc) ne 'HASH';
        next if ($doc->{version} // 0) < 1 || !ref($doc->{snapshot});
        $snaps{$node} = $doc;
    }
    # o snapshot AO VIVO do no local tem sempre precedencia (e cobre o
    # intervalo entre o boot e a primeira passada do publicador)
    $snaps{$nodename} = {
        version => 1,
        node => $nodename,
        timestamp => $now,
        snapshot => $local_snap,
        live => 1,
    };

    my @nodes;
    for my $node (sort keys %snaps) {
        my $doc = $snaps{$node};
        my $snap = $doc->{snapshot};
        my $age = defined($doc->{timestamp}) ? $now - $doc->{timestamp} : undef;
        push @nodes, {
            node => $node,
            podcidr => $snap->{effective}->{podcidr} // '',
            servicecidr => $snap->{effective}->{servicecidr} // '',
            'flannel-iface' => $snap->{effective}->{'flannel-iface'} // '',
            'node-ip' => $snap->{effective}->{'node-ip'} // '',
            backend => $snap->{effective}->{backend} // '',
            conflicts => scalar(@{ $snap->{conflicts} // [] }),
            age => $age,
            # publicador roda a cada minuto; acima de 10 min considera-se
            # esquecido (no reinstalado sem k3s, cron parado...) e sai do
            # calculo de consistencia
            stale => (defined($age) && $age > 600) ? 1 : 0,
            live => $doc->{live} ? 1 : 0,
            snapshot => $snap,
        };
    }

    my @divergence;
    my @fresh = grep { !$_->{stale} && $_->{podcidr} ne '' } @nodes;
    if (@fresh > 1) {
        my $ref = $fresh[0];
        for my $n (@fresh[1 .. $#fresh]) {
            for my $pair (['podcidr', 'pod'], ['servicecidr', 'service']) {
                my ($key, $kind) = @$pair;
                next if $n->{$key} eq $ref->{$key};
                push @divergence, {
                    cidr => $n->{$key},
                    kind => $kind,
                    against => $ref->{$key},
                    against_kind => 'k3s-node',
                    detail => "k3s node $n->{node} declares $n->{$key}"
                        . " (reference $ref->{node} declares $ref->{$key})",
                };
            }
        }
    }

    my $pve_nodelist = eval { PVE::Cluster::get_nodelist() } || [];
    my $k8s_total = scalar(@nodes);

    return {
        %$local_snap,    # compat: campos do no local (declared/effective/unit/...)
        cluster => {
            # nodes_total/reporting sao nos que publicaram k8snet; o total PVE
            # fica separado para nao sugerir que todo host PVE roda k3s.
            nodes_total => $k8s_total,
            nodes_reporting => scalar(grep { !$_->{stale} } @nodes),
            pve_nodes_total => scalar(@$pve_nodelist),
            consistent => (@divergence ? 0 : 1),
        },
        nodes => \@nodes,
        conflicts => [ @{ $local_snap->{conflicts} // [] }, @divergence ],
    };
}

# ---- GET ---------------------------------------------------------------------

__PACKAGE__->register_method({
    name => 'index',
    path => '',
    method => 'GET',
    permissions => { user => 'all' },
    description => 'Cluster Kubernetes network endpoint index.',
    parameters => {
        additionalProperties => 0,
        properties => {},
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
    permissions => { check => ['perm', '/', ['Sys.Audit']] },
    description => 'Read the Kubernetes (k3s) network configuration of the'
        . ' whole PVE cluster: live state of the answering node plus the'
        . ' per-node snapshots published in pmxcfs (per-node CIDRs,'
        . ' divergence between k3s servers, SDN vnets and range conflicts).',
    parameters => {
        additionalProperties => 0,
        properties => {},
    },
    returns => { type => 'object' },
    code => sub {
        my ($param) = @_;

        # snapshot local sempre ao vivo; os pares chegam do status KV do
        # pmxcfs (gravado pelo cron root de cada no via k8snet-publish).
        # Este handler de leitura nunca executa comando em no remoto.
        my $kv = eval { PVE::Cluster::get_node_kv('k8snet-network') } || {};
        return cluster_aggregate(node_snapshot(), $kv);
    },
});

# ---- PUT ---------------------------------------------------------------------

sub write_unit_net_flags {
    my ($flags) = @_; # { 'cluster-cidr' => '10.42.0.0/16', ... } apenas os presentes

    my @lines = read_unit_lines();
    die "k3s unit file not found at $K3S_UNIT\n" if !@lines;
    my ($start, $end) = execstart_block_range(@lines);
    die "ExecStart not found in $K3S_UNIT\n" if !defined($start);

    my @head = $start > 0 ? @lines[0 .. $start - 1] : ();
    my @tail = $end < $#lines ? @lines[$end + 1 .. $#lines] : ();

    # binario: primeiro token da linha "ExecStart=..."
    my ($bin) = $lines[$start] =~ m/^ExecStart=(\S+)/;
    die "unable to parse ExecStart binary in $K3S_UNIT\n" if !$bin;

    my @tokens = parse_execstart_tokens(@lines[$start .. $end]);

    # remove ocorrencias anteriores das flags gerenciadas, em qualquer posicao
    @tokens = grep {
        my $t = $_;
        !grep { $t =~ m/^--$_=/ } @NET_FLAGS;
    } @tokens;

    # acrescenta as novas flags SEMPRE ao FIM da lista de argumentos: o k3s
    # exige que o subcomando ("server") seja o PRIMEIRO argumento, entao as
    # flags de rede nunca podem ser inseridas antes dele. Reconstruir a
    # partir dos tokens (em vez de mexer nas linhas cruas) evita esse bug
    # independente de como o bloco ExecStart estava formatado originalmente.
    push @tokens, map { "--$_=$flags->{$_}" } grep { defined($flags->{$_}) } @NET_FLAGS;

    die "no arguments left for ExecStart\n" if !@tokens;

    my @new_block = ("ExecStart=$bin \\");
    for my $i (0 .. $#tokens) {
        my $suffix = $i < $#tokens ? ' \\' : '';
        push @new_block, "\t'$tokens[$i]'$suffix";
    }

    my $data = join("\n", @head, @new_block, @tail);
    $data .= "\n" if $data !~ m/\n$/;
    my $mode = (stat($K3S_UNIT))[2] & 07777;
    file_set_contents($K3S_UNIT, $data, $mode);
}

sub wait_node_ready {
    my ($timeout) = @_;
    my $deadline = time() + $timeout;
    while (time() < $deadline) {
        my $out = '';
        my $ok = eval {
            run_command(
                [$K3S_BIN, 'kubectl', 'get', 'nodes', '-o', 'json'],
                outfunc => sub { $out .= shift },
                errfunc => sub {},
            );
            1;
        };
        if ($ok && $out) {
            my $data = eval { decode_json($out) };
            if (ref($data) eq 'HASH') {
                my $ready_all = 1;
                my $count = 0;
                for my $node (@{ $data->{items} // [] }) {
                    $count++;
                    my $is_ready = 0;
                    for my $cond (@{ $node->{status}->{conditions} // [] }) {
                        $is_ready = 1
                            if ($cond->{type} // '') eq 'Ready'
                            && ($cond->{status} // '') eq 'True';
                    }
                    $ready_all = 0 if !$is_ready;
                }
                return 1 if $count && $ready_all;
            }
        }
        sleep(2);
    }
    return 0;
}

sub restore_unit_backup {
    my ($task_backup) = @_;
    my $bak = "$K3S_UNIT.bak-k8snet";
    die "no k3s unit backup to restore\n" if !-f $bak;
    my $mode = (stat($bak))[2] & 07777;
    my $data = file_get_contents($bak);
    file_set_contents($K3S_UNIT, $data, $mode);
    run_command(['systemctl', 'daemon-reload']);
    run_command(['systemctl', 'restart', 'k3s']);
    my $ready = wait_node_ready(150);
    die "k3s did not become Ready even after restoring the backup"
        . " (manual intervention required; failed unit saved at $task_backup)\n"
        if !$ready;
}

# Pre-flight por no: unit presente e nenhuma faixa nova sobrepondo interfaces/
# VNets locais. Roda localmente (fan-out do PUT de cluster) e dentro do script
# k8snet-apply-node --check (mesma checagem no no remoto, antes de aplicar em
# qualquer host), evitando aplicar pela metade num cluster de N servidores.
sub check_node_net_flags {
    my ($flags) = @_;

    die "k3s unit file not found at $K3S_UNIT\n" if !-f $K3S_UNIT;
    my $interfaces = live_interfaces();
    my $sdn_vnets = [ sdn_vnets_flat($interfaces) ];
    for my $flag (qw(cluster-cidr service-cidr)) {
        next if !defined($flags->{$flag});
        for my $if (@$interfaces) {
            next if is_cni_interface($if->{name});
            if (ip_overlaps($flags->{$flag}, "$if->{ip}/$if->{prefix}")) {
                die "check failed: $flag overlaps interface"
                    . " $if->{name} ($if->{ip}/$if->{prefix})\n";
            }
        }
        for my $v (@$sdn_vnets) {
            next if !$v->{cidr};
            if (ip_overlaps($flags->{$flag}, $v->{cidr})) {
                die "check failed: $flag overlaps SDN vnet $v->{vnet} ($v->{cidr})\n";
            }
        }
    }
    return 1;
}

# Aplica as flags NESTE host: pre-flight, backup, reescrita da unit,
# daemon-reload, restart e rollback automatico se o no nao voltar a Ready.
# Corpo extraido do antigo $realcmd: hoje e chamado diretamente no no local
# pelo fan-out do PUT de cluster e indiretamente nos nos remotos (e pelo
# endpoint per-node) via /usr/local/sbin/k8snet-apply-node -- uma unica
# implementacao para todos os caminhos.
sub apply_node_net_flags {
    my ($flags, $restart) = @_;

    check_node_net_flags($flags);

    print "applying k3s network flags: "
        . join(', ', map { "--$_=$flags->{$_}" } sort keys %$flags) . "\n";

    my $bak = "$K3S_UNIT.bak-k8snet";
    if (!-f $bak) {
        my $mode = (stat($K3S_UNIT))[2] & 07777;
        file_set_contents($bak, file_get_contents($K3S_UNIT), $mode);
        print "backup saved: $bak\n";
    } else {
        print "backup already present: $bak (preserved)\n";
    }

    my $failed_copy = "$K3S_UNIT.failed-k8snet-" . time();
    eval {
        write_unit_net_flags($flags);
        print "unit updated: $K3S_UNIT\n";
        run_command(['systemctl', 'daemon-reload']);
        if ($restart) {
            print "restarting k3s...\n";
            run_command(['systemctl', 'restart', 'k3s']);
            if (wait_node_ready(150)) {
                print "k3s node Ready\n";
            } else {
                die "k3s did not become Ready within timeout\n";
            }
        } else {
            print "restart skipped (--restart=0): unit updated only\n";
        }
    };
    if (my $err = $@) {
        print "FAILED: $err";
        if (-f $bak) {
            print "restoring previous unit from $bak\n";
            eval {
                file_set_contents($failed_copy, file_get_contents($K3S_UNIT), 0644)
                    if -f $K3S_UNIT;
                restore_unit_backup($failed_copy);
                print "previous configuration restored and Ready\n";
            };
            die "rollback failed: $@" if $@;
        }
        die $err;
    }
    return 1;
}

# Executa o script aplicador num no REMOTO via o mesmo SSH nativo que
# LXC/Qemu usam para migracao (chaves de cluster, sem senha). $mode:
# 'check' (pre-flight, nao altera nada) ou 'apply'.
sub run_apply_on {
    my ($node, $mode, $flags, $restart) = @_;

    my @remote = ($APPLY_SCRIPT);
    push @remote, '--check' if $mode eq 'check';
    push @remote, '--rollback' if $mode eq 'rollback';
    push @remote, map { "--$_=" . $flags->{$_} } grep { defined($flags->{$_}) } @NET_FLAGS;
    push @remote, '--no-restart' if !$restart;

    my $sshinfo = PVE::SSHInfo::get_ssh_info($node);
    my $cmd = [ @{ PVE::SSHInfo::ssh_info_to_command($sshinfo) }, @remote ];
    run_command($cmd,
        outfunc => sub { print "  [$node] ", shift, "\n" },
        errfunc => sub { print "  [$node] ", shift, "\n" });
    return 1;
}

__PACKAGE__->register_method({
    name => 'update',
    path => 'network',
    method => 'PUT',
    permissions => { check => ['perm', '/', ['Sys.Modify']] },
    protected => 1,
    description => 'Apply Kubernetes (k3s) network settings across the PVE'
        . ' cluster: rewrite the network flags in the k3s systemd unit of'
        . ' every target node and restart the service there as a PVE task.'
        . ' Targets default to ALL nodes (k3s servers must share the CIDRs);'
        . ' pass nodes to restrict. Pre-flight checks run on every target'
        . ' before anything is changed; a node that fails the check aborts'
        . ' the whole run. Automatically restores the previous unit if a'
        . ' node does not become Ready again.',
    parameters => {
        additionalProperties => 0,
        properties => {
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
            nodes => {
                type => 'string', optional => 1,
                description => 'Target nodes (comma-separated). Defaults to all'
                    . ' cluster nodes; k3s servers must share the CIDRs.',
                format => 'pve-node-list',
            },
        },
    },
    returns => { type => 'string' },
    code => sub {
        my ($param) = @_;

        my $rpcenv = PVE::RPCEnvironment::get();
        my $authuser = $rpcenv->get_user();

        my %flags;
        if (defined(my $v = $param->{'cluster-cidr'})) {
            $flags{'cluster-cidr'} = validate_cidr($v, 'cluster-cidr');
        }
        if (defined(my $v = $param->{'service-cidr'})) {
            $flags{'service-cidr'} = validate_cidr($v, 'service-cidr');
        }
        if (defined(my $v = $param->{'flannel-iface'})) {
            $flags{'flannel-iface'} = validate_iface($v, 'flannel-iface');
        }
        if (defined(my $v = $param->{'node-ip'})) {
            $flags{'node-ip'} = validate_ip($v, 'node-ip');
        }
        raise_param_exc({ body => 'no network setting supplied' }) if !%flags;
        # cluster-cidr/service-cidr sao globais no cluster k3s: todo no alvo
        # precisa passar o mesmo pre-flight. O no local tambem participa para
        # que um PUT falhe antes de iniciar qualquer mudanca remota.
        check_node_net_flags(\%flags);

        my $restart = $param->{restart} // 1;
        # pvedaemon roda com -T: nomes de no viram argumento de ssh no
        # fan-out -> capturar via regex antes de usar.
        my $launder_node = sub {
            my ($raw) = @_;
            $raw =~ m/^([A-Za-z0-9][A-Za-z0-9.-]*)$/
                or raise_param_exc({ nodes => 'invalid node name' });
            return $1;
        };

        my @nodes;
        if (defined($param->{nodes}) && $param->{nodes} ne '') {
            @nodes = map { $launder_node->($_) } split_list($param->{nodes});
        } else {
            @nodes = map { $launder_node->($_) } @{ PVE::Cluster::get_nodelist() };
        }
        raise_param_exc({ nodes => 'no target nodes found' }) if !@nodes;

        my $local = $launder_node->(PVE::INotify::nodename());
        my %seen;
        @nodes = grep { $_ ne '' && !$seen{$_}++ } @nodes;
        my %known = map { $_ => 1 } @{ PVE::Cluster::get_nodelist() };
        for my $node (@nodes) {
            raise_param_exc({ nodes => "unknown PVE node '$node'" }) if !$known{$node};
        }

        my $realcmd = sub {
            my ($upid) = @_;
            print "Kubernetes network fan-out targets: " . join(', ', @nodes) . "\n";

            # Segundo pre-flight nos remotos. Nenhuma unit e escrita antes de
            # todos os nos confirmarem que a faixa e a unit sao aplicaveis.
            for my $node (@nodes) {
                if ($node eq $local) {
                    check_node_net_flags(\%flags);
                } else {
                    run_apply_on($node, 'check', \%flags, $restart);
                }
            }
            print "pre-flight OK on all target nodes\n";

            # Aplicacao sequencial, com snapshot de flags anteriores para
            # rollback distribuido se algum host falhar. A tarefa mostra qual
            # no falhou; os hosts ja aplicados recebem os valores anteriores.
            my @applied;
            eval {
                for my $node (@nodes) {
                    print "applying on $node\n";
                    if ($node eq $local) {
                        apply_node_net_flags(\%flags, $restart);
                    } else {
                        run_apply_on($node, 'apply', \%flags, $restart);
                    }
                    push @applied, $node;
                }
            };
            if (my $err = $@) {
                print "FAILED during fan-out: $err";
                # O script remoto conserva .bak-k8snet, logo a recuperacao de
                # cada host aplicado e deterministica. O rollback remoto usa
                # o helper como uma operacao interna, sem expor caminhos ao UI.
                for my $node (reverse @applied) {
                    eval {
                        if ($node eq $local) {
                            restore_unit_backup("$K3S_UNIT.failed-fanout-" . time());
                        } else {
                            run_apply_on($node, 'rollback', {}, 1);
                        }
                    };
                    print "rollback $node failed: $@" if $@;
                }
                die $err;
            }
            print "fan-out done\n";
            return;
        };

        return $rpcenv->fork_worker('k8snet', 'network', $authuser, $realcmd);
    },
});

1;
