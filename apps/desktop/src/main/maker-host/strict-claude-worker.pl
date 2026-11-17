use strict;
use warnings;
use JSON::PP qw(decode_json encode_json);
use Cwd qw(abs_path);
use Encode qw(encode decode FB_CROAK);
binmode STDOUT, ":encoding(UTF-8)";
use File::Basename qw(dirname basename);

# This program is always entered through sandbox-exec. stdin is data, never code.
local $/;
my $request = decode_json(<STDIN>);
my $root = encode('UTF-8', $request->{root});
my $args = $request->{args};
my $tool = $request->{tool};
sub task_path {
    my ($value, $new) = @_;
    die "Invalid path\n" if !defined($value) || $value =~ /\0/;
    $value = encode('UTF-8', $value);
    my $input = $value =~ m{^/} ? $value : "$root/$value";
    my $resolved = abs_path($input);
    if (!defined($resolved) && $new) {
        my $parent = abs_path(dirname($input));
        die "Parent directory missing\n" unless defined $parent;
        my $leaf = basename($input);
        die "Invalid filename\n" if $leaf eq '.' || $leaf eq '..';
        $resolved = "$parent/$leaf";
    }
    die "Path outside task directory\n" unless defined($resolved) && ($resolved eq $root || index($resolved, "$root/") == 0);
    return $resolved;
}
sub read_file {
    my ($file) = @_;
    die "Not a regular file\n" unless -f $file;
    die "File exceeds 1 MiB\n" if -s $file > 1048576;
    open(my $handle, '<:raw', $file) or die "Cannot read file: $!\n";
    my $data = <$handle> // '';
    close $handle;
    return decode('UTF-8', $data, FB_CROAK);
}
if ($tool eq 'read_file') {
    print read_file(task_path($args->{path}, 0));
} elsif ($tool eq 'list_files') {
    my $dir = task_path($args->{path}, 0);
    opendir(my $handle, $dir) or die "Cannot list directory: $!\n";
    my @names = sort grep { $_ ne '.' && $_ ne '..' } readdir($handle);
    closedir $handle;
    print JSON::PP->new->encode([map { decode('UTF-8', $_, FB_CROAK) } @names]);
} elsif ($tool eq 'write_file' || $tool eq 'edit_file') {
    my $file = task_path($args->{path}, $tool eq 'write_file');
    my $data = $args->{content};
    if ($tool eq 'edit_file') {
        $data = read_file($file);
        my $old = $args->{old_text};
        die "old_text must not be empty\n" unless length($old);
        my $count = () = $data =~ /\Q$old\E/g;
        die "Expected exactly one match\n" unless $count == 1;
        $data =~ s/\Q$old\E/$args->{new_text}/;
    }
    open(my $handle, '>:raw', $file) or die "Cannot write file: $!\n";
    print $handle encode('UTF-8', $data);
    close $handle or die "Cannot finish write: $!\n";
    print "OK\n";
} elsif ($tool eq 'command') {
    exec '/bin/bash', '--noprofile', '--norc', '-c', $args->{command};
    die "Cannot start command: $!\n";
} elsif ($tool eq 'web_fetch') {
    my $url = $args->{url};
    die "Only HTTP(S) URLs are supported\n" unless $url =~ m{^https?://}i;
    # Only the host supplies this path; tool arguments cannot override trust.
    my $ca_file = $request->{caFile};
    $ca_file = encode('UTF-8', $ca_file) if defined($ca_file);
    die "Trusted CA bundle unavailable\n" unless defined($ca_file) && -f $ca_file && -r $ca_file && -s $ca_file;
    # -q is first: no .curlrc, explicit proxy, no bypass list, no redirects,
    # no retries to another route. CONNECT and hostname resolution use the proxy.
    exec '/usr/bin/curl', '-q', '--proxy', 'http://127.0.0.1:7897',
      '--cacert', $ca_file,
      '--noproxy', '', '--proto', '=http,https', '--proto-redir', '=http,https',
      '--max-time', '30', '--max-filesize', '1048576', '--fail-with-body',
      '--silent', '--show-error', '--include', '--url', $url;
    die "Cannot start fetch: $!\n";
} else {
    die "Tool unavailable\n";
}
