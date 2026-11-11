# Build rules for the Pebble SDK (plugins branch): a plugin-only pbw with no watch binary.
# Until the released pebble-tool can build plugin-only projects, use scripts/pack-plugin-pbw.py.
top = '.'
out = 'build'


def options(ctx):
    ctx.load('pebble_sdk')


def configure(ctx):
    ctx.load('pebble_sdk')


def build(ctx):
    ctx.load('pebble_sdk')
    ctx.pbl_bundle(binaries=[])
