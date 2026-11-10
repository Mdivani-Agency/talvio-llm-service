import { randomUUID } from 'crypto';

import {
  createMemoryQueues,
  createNoQueues,
  createSqsQueues,
  dispatchEvent,
  parseWorkMessage,
  toWorkMessage,
} from './queue';
import { createMemoryStore } from './store/memory';
import type { OutboxEvent } from './store';

const event = (): OutboxEvent => ({
  eventId: randomUUID(),
  type: 'job.admitted',
  ownerId: randomUUID(),
  jobId: randomUUID(),
  operation: 'parse_document',
  pipelineReleaseId: 'v1',
  createdAt: new Date(),
  availableAt: new Date(),
});

describe('work messages', () => {
  it('carry identifiers only', () => {
    const e = event();
    const message = toWorkMessage(e);
    expect(Object.keys(message).sort()).toEqual(['eventId', 'jobId', 'ownerId', 'type', 'v']);
    expect(parseWorkMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each([
    'not json',
    '{}',
    JSON.stringify({ ...toWorkMessage(event()), extra: 'x' }),
    JSON.stringify({ ...toWorkMessage(event()), jobId: 'nope' }),
    JSON.stringify({ ...toWorkMessage(event()), v: 2 }),
  ])('are rejected when malformed: %s', (body) => {
    expect(parseWorkMessage(body)).toBeNull();
  });
});

describe('SQS queues', () => {
  it('send to the release queue and fail for an unknown release', async () => {
    const send = jest.fn().mockResolvedValue({});
    const queues = createSqsQueues({ v1: 'https://sqs.us-west-1.amazonaws.com/1/q' }, { send });
    await queues.send('v1', toWorkMessage(event()));
    expect(send).toHaveBeenCalledTimes(1);
    await expect(queues.send('v9', toWorkMessage(event()))).rejects.toThrow('no work queue');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('are unavailable when none is configured', async () => {
    await expect(createNoQueues().send('v1', toWorkMessage(event()))).rejects.toMatchObject({
      code: 'dependency_unavailable',
    });
  });
});

describe('dispatchEvent', () => {
  it('marks the event dispatched only after the send succeeded', async () => {
    const store = createMemoryStore();
    const queues = createMemoryQueues();
    const markDispatched = jest.spyOn(store.outbox, 'markDispatched');
    queues.failNext = 1;
    await expect(
      dispatchEvent({ store, queues, currentRelease: 'v1' }, event(), new Date()),
    ).rejects.toThrow();
    expect(markDispatched).not.toHaveBeenCalled();
    await dispatchEvent({ store, queues, currentRelease: 'v1' }, event(), new Date());
    expect(markDispatched).toHaveBeenCalledTimes(1);
    expect(queues.sent).toHaveLength(1);
  });
});
