import 'mocha';
import { expect } from 'chai';
import { TaskParser } from '../src/taskParser';
import { App } from 'obsidian';

// Mock the Obsidian App class
const mockApp = {
    vault: {
        // Mock any functions that might be called
        getMarkdownFiles: () => [],
        read: (file: string) => Promise.resolve(''),
    },
} as unknown as App;

describe('TaskParser', () => {
    let parser: TaskParser;

    before(() => {
        parser = new TaskParser(mockApp);
    });

    it('should be created', () => {
        expect(parser).to.not.be.undefined;
    });

    it('should parse a task with a space-separated date and time', () => {
        const line = '- [ ] テスト　📅 2025-08-23 🛫 2025-08-23 12:00';
        const task = parser.parseObsidianTask(line, 'test.md', 0);

        expect(task).to.not.be.null;
        if (!task) return;

        // The date format should be normalized to something moment.js can parse with time
        expect(task.startDate).to.equal('2025-08-23T12:00');
        expect(task.dueDate).to.equal('2025-08-23');
        expect(task.summary).to.equal('テスト');
    });

    it('should parse a task with both due and start datetimes', () => {
        const line = '- [ ] テスト　📅 2025-08-23 22:00 🛫 2025-08-23 12:00';
        const task = parser.parseObsidianTask(line, 'test.md', 1);

        expect(task).to.not.be.null;
        if (!task) return;

        expect(task.dueDate).to.equal('2025-08-23T22:00');
        expect(task.startDate).to.equal('2025-08-23T12:00');
        expect(task.summary).to.equal('テスト');
    });

    it('should parse a task with both due and start dates (no time)', () => {
        const line = '- [ ] テスト　📅 2025-08-23 🛫 2025-08-23';
        const task = parser.parseObsidianTask(line, 'test.md', 2);

        expect(task).to.not.be.null;
        if (!task) return;

        expect(task.dueDate).to.equal('2025-08-23');
        expect(task.startDate).to.equal('2025-08-23');
        expect(task.summary).to.equal('テスト');
    });

    it('should use dueDate as startDate if startDate is not present', () => {
        const line = '- [ ] テスト　📅 2025-08-23';
        const task = parser.parseObsidianTask(line, 'test.md', 3);

        expect(task).to.not.be.null;
        if (!task) return;

        expect(task.dueDate).to.equal('2025-08-23');
        expect(task.startDate).to.equal('2025-08-23');
        expect(task.summary).to.equal('テスト');
    });
});

export {};
