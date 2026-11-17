import assert from 'node:assert/strict';
import test from 'node:test';
import { registerCommands } from '../src/handlers/loaders/commandLoader.js';

function createClient({ guilds, botId = 'application-id' } = {}) {
    const calls = [];
    const makeCommand = name => ({
        category: 'Fun',
        data: {
            name,
            toJSON: () => ({ name, description: `${name} command` }),
        },
    });
    const client = {
        user: { id: botId },
        commands: new Map([
            ['rps', makeCommand('rps')],
            ['rps-copy', makeCommand('rps')],
            ['connectfour', makeCommand('connectfour')],
        ]),
        guilds: {
            cache: {
                values: () => guilds || [
                    { id: 'guild-one', name: 'Guild One' },
                    { id: 'guild-two', name: 'Guild Two' },
                ],
            },
        },
        rest: {
            put: async (route, options) => calls.push({ method: 'put', route, options }),
        },
    };
    return { client, calls };
}

test('registers each command globally once and clears guild-scoped copies in every guild', async () => {
    const { client, calls } = createClient();
    await registerCommands(client, { clientId: 'application-id' });

    const globalRegistration = calls.find(call => call.route === '/applications/application-id/commands');
    assert.ok(globalRegistration);
    assert.deepEqual(globalRegistration.options.body.map(command => command.name), ['rps', 'connectfour']);
    assert.deepEqual(
        calls.filter(call => call.route.includes('/guilds/')).map(call => call.route),
        [
            '/applications/application-id/guilds/guild-one/commands',
            '/applications/application-id/guilds/guild-two/commands',
        ],
    );
    assert.ok(calls.filter(call => call.route.includes('/guilds/')).every(call =>
        call.options.body.length === 0,
    ));
});

test('does not register commands against a different application ID', async () => {
    const { client, calls } = createClient({ botId: 'different-application-id' });

    await assert.rejects(
        registerCommands(client, { clientId: 'application-id' }),
        /does not match the logged-in bot application/,
    );
    assert.equal(calls.length, 0);
});
