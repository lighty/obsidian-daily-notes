# Build rules for `pebble build` (pebble-tool 5.1+, SDK 4.44+): a plugin-only pbw with no watch
# binary. scripts/pack-plugin-pbw.py makes the same pbw without the SDK.
top = '.'
out = 'build'


def options(ctx):
    ctx.load('pebble_sdk')


def configure(ctx):
    ctx.load('pebble_sdk')


def build(ctx):
    ctx.load('pebble_sdk')
    ctx.pbl_bundle(binaries=[])
