import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('local.auggie-workbench'));
	});

	test('Should activate extension', async () => {
		const ext = vscode.extensions.getExtension('local.auggie-workbench');
		assert.ok(ext);
		await ext.activate();
		assert.strictEqual(ext.isActive, true);
	});

	test('Should register Auggie commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		const auggieCommands = commands.filter(c => c.startsWith('auggie.'));
		assert.ok(auggieCommands.length > 0, 'Auggie commands should be registered');
		assert.ok(auggieCommands.includes('auggie.connectAuggie'), 'connectAuggie command should exist');
		assert.ok(auggieCommands.includes('auggie.connectAgent'), 'connectAgent command should exist');
		assert.ok(auggieCommands.includes('auggie.newConversation'), 'newConversation command should exist');
		assert.ok(auggieCommands.includes('auggie.openChat'), 'openChat command should exist');
		assert.ok(auggieCommands.includes('auggie.openLatestThread'), 'openLatestThread command should exist');
	});
});
