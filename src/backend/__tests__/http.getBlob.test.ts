import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlobTransferError, HttpStorageAdapter } from '../http';

const adapter = () => new HttpStorageAdapter({ endpoint: 'https://sync.example', deviceToken: 'token' });

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('HttpStorageAdapter.getBlob', () => {
    it('classifies a fetch rejection as request and retries it', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockRejectedValue(new TypeError('Load failed'));

        const result = expect(adapter().getBlob('request-hash', {
            itemId: 'chat/a',
            itemType: 'chat',
        })).rejects.toMatchObject({
            name: 'BlobTransferError',
            stage: 'request',
            hash: 'request-hash',
        });

        await vi.runAllTimersAsync();
        await result;
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('classifies a body stream rejection as response-body and retains response metadata', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const response = {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'Content-Length': '42', 'cf-ray': 'ray-123' }),
            arrayBuffer: vi.fn().mockRejectedValue(new TypeError('body stream interrupted')),
        } as unknown as Response;
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

        const result = expect(adapter().getBlob('body-hash')).rejects.toMatchObject({
            name: 'BlobTransferError',
            stage: 'response-body',
            hash: 'body-hash',
            status: 200,
            contentLength: '42',
            cfRay: 'ray-123',
        });

        await vi.runAllTimersAsync();
        await result;
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not retry a non-transient HTTP response', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
            status: 404,
            statusText: 'Not Found',
            headers: { 'cf-ray': 'ray-404' },
        }));

        await expect(adapter().getBlob('missing-hash')).rejects.toEqual(expect.objectContaining<Partial<BlobTransferError>>({
            name: 'BlobTransferError',
            stage: 'request',
            status: 404,
            cfRay: 'ray-404',
        }));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
