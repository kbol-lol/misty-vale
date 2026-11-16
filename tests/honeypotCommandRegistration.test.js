import assert from 'node:assert/strict';
import test from 'node:test';
import { registerCommands } from '../src/handlers/loaders/commandLoader.js';

function createClient(registeredGuildCommands = []) {
    const calls = [];
    const commandData = {
        name: 'honeypot',
        description: 'Configure the server honeypot',
        options: [{ type: 1, name: 'dashboard', description: 'Open the settings dashboard' }],
    };
    const client = {
        commands: new Map([['honeypot', {
            category: 'Moderation',
            data: { name: 'honeypot', toJSON: () => commandData },
        }]]),
        guilds: { cache: { values: () => [{ id: 'target-guild-id', name: 'Target Guild' }] } },
        rest: {
            put: async (route, options) => calls.push({ method: 'put', route, options }),
            get: async route => {
                calls.push({ method: 'get', route });
                return registeredGuildCommands;
            },
            delete: async route => calls.push({ method: 'delete', route }),
        },
    };
    return { client, calls };
}

test('registers honeypot globally and removes a duplicate guild-scoped command', async () => {
    const { client, calls } = createClient([
        { id: 'existing-honeypot-id', name: 'honeypot', type: 1 },
        { id: 'existing-moderation-id', name: 'moderation', type: 1 },
    ]);

    await registerCommands(client, {
        clientId: 'application-id',
    });

    assert.ok(calls.some(call => call.method === 'put' && call.route === '/applications/application-id/commands'));
    assert.ok(calls.some(call =>
        call.method === 'delete'
        && call.route === '/applications/application-id/guilds/target-guild-id/commands/existing-honeypot-id',
    ));
    assert.equal(calls.some(call => call.method === 'delete' && call.route.endsWith('existing-moderation-id')), false);
    assert.equal(calls.some(call => call.method === 'post'), false);
});
