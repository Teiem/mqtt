<script lang="ts">
	import * as mqtt from 'precompiled-mqtt';
	import { onMount } from 'svelte';
	import { db, type Message as _Message } from '../lib/data';
	import { formatDuration, intervalToDuration } from 'date-fns';

	const SETTINGS = {
		WINDOW_SIZE: 300,
		LOAD_MORE_SIZE: 5
	} as const;

	type Message = _Message & { loading?: boolean };

	/** from old to new */
	let messages: Message[] = [];
	let client: mqtt.MqttClient;

	let server = 'ws://test.mosquitto.org:8080';
	let topic = ['test'];

	let serverInput = server;
	let topicInput = topic.join(', ');

	let messageFilterInput = '';
	let topicFilterInput = '';
	let topicFilter: ((message: _Message) => boolean) | undefined;
	let messageFilter: ((message: _Message) => boolean) | undefined;

	let lastScrollY = 100;
	let scrollContainer: HTMLTableSectionElement;

	const openFilters: Record<string, boolean> = {};

	let now = new Date();
	setInterval(() => {
		now = new Date();
	}, 1000);

	const loadInitialData = async () => {
		let _messages = db.messages.orderBy('timestamp').reverse();

		if (topicFilter) _messages = _messages.filter(topicFilter);
		if (messageFilter) _messages = _messages.filter(messageFilter);

		messages = (await _messages.limit(SETTINGS.WINDOW_SIZE).toArray()).reverse();

		setTimeout(() => {
			scrollToBottom();
		}, 100);
	};

	let newMessages: Message[] = [];
	let newMessagesAddQueued = false;

	const queAddNewMessages = (message: Message) => {
		if (messageFilter && !messageFilter(message)) return;
		if (topicFilter && !topicFilter(message)) return;

		newMessages.push(message);

		if (newMessagesAddQueued) return;
		newMessagesAddQueued = true;

		requestAnimationFrame(() => {
			newMessagesAddQueued = false;
			messages.push(...newMessages);

			setTimeout(() => scrollToBottom(newMessages.length >= 5 ? 'auto' : 'smooth'), 0);

			messages.splice(0, Math.min(newMessages.length, messages.length - SETTINGS.WINDOW_SIZE));
			newMessages = [];
			messages = messages;
		});
	};

	const connectToClient = () => {
		client?.end();

		loadInitialData();

		client = mqtt.connect(server);
		client.on('connect', () => subscribe(topic));
		client.on('message', (topic, messageBuffer) => {
			const message = messageBuffer.toString();
			const timestamp = new Date().toISOString();
			const id = crypto.randomUUID();

			const newMessage = {
				id,
				message,
				topic,
				timestamp
			};

			db.messages.add(newMessage);
			if (hitBottom) queAddNewMessages(newMessage);
			messages = messages;
		});
	};

	const subscribe = (newTopics: string[], oldTopics?: string[]) => {
		oldTopics?.forEach((topic) => client.unsubscribe(topic));

		newTopics.forEach((topic) => {
			client.subscribe(topic, (err) => {
				if (err) throw err;
			});
		});
	};

	let hitTop = false;
	let hitBottom = true;
	let disableScrollFetch = false;

	let loadingID = 0;
	let hideLoadingMessages = false;

	const fastForward = <T>(
		until: (value: T) => boolean,
		otherCriteria: (value: T) => boolean = () => true
	): ((value: T) => boolean) => {
		let fastForwardComplete = false;
		return (item) => {
			if (fastForwardComplete) return otherCriteria(item);
			if (until(item)) fastForwardComplete = true;
			return false;
		};
	};

	const createLoadingMessages = (length: number) =>
		Array.from({ length }, () => ({
			id: String(loadingID++),
			message: 'loading...',
			topic: '...',
			timestamp: '...',
			loading: true
		}));

	const replaceLoadingMessagesWithLoaded = (loading: Message[], loaded: Message[]) =>
		loading.forEach((message, i) =>
			loaded[i] ? Object.assign(message, loaded[i], { loading: false }) : messages.splice(messages.indexOf(message), 1)
		);

	/**
	 * General concept:
	 * 1. generate some placeholder messages
	 * 2. Find the newest message in the current messages array
	 * 3. get data from the database
	 *      - multiple elements can have the same timestamp, so we search for the last one we know of using its id
	 * 4. replace the placeholder messages with the loaded messages and and remove the same amount of messages from the start of the array
	 */
	const loadNewer = async () => {
		if (disableScrollFetch || !messages.length) return;

		const newestMessageIndex = messages.findLastIndex(({ loading }) => !loading);
		const { timestamp: newestMessageTimestamp, id: newestMessageId } = messages[newestMessageIndex];
		const offset = messages.length - newestMessageIndex - 1;

		const loadingMessages = createLoadingMessages(SETTINGS.LOAD_MORE_SIZE);

		messages.push(...loadingMessages);
		messages = messages;

		const _newMessages = db.messages
			.where('timestamp')
			.aboveOrEqual(newestMessageTimestamp)
			.filter(fastForward(({ id }) => id === newestMessageId));

		if (topicFilter) _newMessages.filter(topicFilter);
		if (messageFilter) _newMessages.filter(messageFilter);

		const newMessages = await _newMessages //
			.offset(offset)
			.limit(5)
			.toArray();

		hideLoadingMessages = newMessages.length !== SETTINGS.LOAD_MORE_SIZE;
		messages.splice(0, newMessages.length);
		replaceLoadingMessagesWithLoaded(loadingMessages, newMessages);
		messages = messages;
	};

	const loadOlder = async () => {
		if (disableScrollFetch || !messages.length) return;

		const oldestMessageIndex = messages.findIndex(({ loading }) => !loading);
		const { timestamp: oldestMessageTimestamp, id: oldestMessageId } = messages[oldestMessageIndex];

		const loadingMessages = createLoadingMessages(SETTINGS.LOAD_MORE_SIZE);

		messages.unshift(...loadingMessages);
		messages = messages;

		const _newMessages = db.messages
			.where('timestamp')
			.belowOrEqual(oldestMessageTimestamp)
			.reverse()
			.filter(fastForward(({ id }) => id === oldestMessageId));

		if (topicFilter) _newMessages.filter(topicFilter);
		if (messageFilter) _newMessages.filter(messageFilter);

		const newMessages = (
			await _newMessages //
				.offset(oldestMessageIndex)
				.limit(SETTINGS.LOAD_MORE_SIZE)
				.toArray()
		).reverse();

		hideLoadingMessages = newMessages.length !== SETTINGS.LOAD_MORE_SIZE;
		if (newMessages.length) messages.splice(-newMessages.length);
		replaceLoadingMessagesWithLoaded(loadingMessages, newMessages);
		messages = messages;
	};

	let enableScrollFetchTimeout: ReturnType<typeof setTimeout>;
	const scrollToBottom = (behavior: 'auto' | 'smooth' | undefined = 'auto') => {
		disableScrollFetch = true;
		clearTimeout(enableScrollFetchTimeout);
		enableScrollFetchTimeout = setTimeout(() => (disableScrollFetch = false), behavior === 'smooth' ? 200 : 50);

		scrollContainer?.scrollTo({
			top: scrollContainer.scrollHeight,
			behavior
		});
	};

	onMount(connectToClient);
</script>

<main>
	<form
		class="settings"
		on:submit|preventDefault={() => {
			if (serverInput !== server) {
				server = serverInput;
				connectToClient();
			}
			const trimmed = topicInput.split(',').map((t) => t.trim());
			if (topic.length !== trimmed.length || topic.some((t) => !trimmed.includes(t))) {
				const added = trimmed.filter((t) => !topic.includes(t));
				const removed = topic.filter((t) => !trimmed.includes(t));
				topic = trimmed;
				subscribe(added, removed);
			}
		}}
	>
		<label>
			<span>Server</span>
			<input type="text" bind:value={serverInput} />
		</label>
		<label>
			<span>Topic</span>
			<input type="text" bind:value={topicInput} />
		</label>
		<button>Subscribe</button>
		<button
			type="button"
			on:click={() => {
				db.messages.clear();
				messages = [];
				hitBottom = true;
			}}>Clear Logs</button
		>
	</form>
	<table class="list" class:hitTop class:hitBottom>
		<thead>
			<tr>
				<th class="topic" class:filtered={topicFilter}>
					<details bind:open={openFilters.topic}>
						<summary>Topic</summary>
						<form
							on:submit|preventDefault={() => {
								if (topicFilterInput) {
									const regex = new RegExp(
										'^' + topicFilterInput.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&').replaceAll('#', '.*') + '$'
									); // allow # as wildcard, otherwise exact match
									topicFilter = ({ topic }) => regex.test(topic);
									loadInitialData();
								} else {
									topicFilter = undefined;
								}
								openFilters.topic = false;
							}}
						>
							<label>
								<span>Filter</span>
								<input type="text" class="filter" bind:value={topicFilterInput} />
							</label>
						</form>
					</details>
				</th>
				<th class="message" class:filtered={messageFilter}>
					<details bind:open={openFilters.message}>
						<summary>Message</summary>
						<form
							on:submit|preventDefault={() => {
								if (messageFilterInput) {
									const _messageFilterInput = messageFilterInput;
									messageFilter = ({ message }) => message.includes(_messageFilterInput);
									loadInitialData();
								} else {
									messageFilter = undefined;
								}
								openFilters.message = false;
							}}
						>
							<label>
								<span>Filter</span>
								<input type="text" class="filter" bind:value={messageFilterInput} />
							</label>
						</form>
					</details>
				</th>
				<th class="timestamp">Time</th>
			</tr>
		</thead>
		<tbody
			bind:this={scrollContainer}
			on:scroll={({ currentTarget }) => {
				const curScrollY = currentTarget.scrollTop;
				const dir = curScrollY > lastScrollY ? 'down' : 'up';
				lastScrollY = curScrollY;

				const remainingDist =
					dir === 'up' ? curScrollY : currentTarget.scrollHeight - curScrollY - currentTarget.clientHeight;

				if (remainingDist < currentTarget.clientHeight) {
					if (dir === 'down') loadNewer();
					else loadOlder();
				}

				if (remainingDist < 10) {
					if (dir === 'up') hitTop = true;
					else hitBottom = true;
				} else {
					hitTop = false;
					hitBottom = false;
				}
			}}
		>
			{#each messages as { message, topic, id, timestamp, loading } (id)}
				{#if !(loading && hideLoadingMessages)}
					<tr>
						<td class="topic" title={topic} tabindex="0" on:dblclick={() => navigator.clipboard.writeText(topic)}>
							{topic}
						</td>
						<td class="message" title={message} tabindex="0" on:dblclick={() => navigator.clipboard.writeText(message)}>
							{message}
						</td>
						<td
							class="timestamp"
							title={timestamp}
							tabindex="0"
							on:dblclick={() => navigator.clipboard.writeText(timestamp)}
						>
							{loading
								? timestamp
								: formatDuration(
										intervalToDuration({
											start: new Date(timestamp),
											end: now
										})
								  ) || 'now'}
						</td>
					</tr>
				{/if}
			{/each}
		</tbody>
	</table>
</main>

<style>
	:root {
		--background-color: #1d1f26;
		--table-row-background-color: #23262f;
		--table-row-background-color-hover: #2d303b;
	}

	main {
		display: flex;
		flex-direction: column;
		height: 100vh;
		background-color: var(--background-color);
		font-family: 'Poppins', sans-serif;
		box-sizing: border-box;
		color: #dbe0e8;
		padding: 0 4rem;
		overflow: hidden;
	}

	form {
		flex: auto;
		display: flex;
		margin: 2rem 0;
		font-size: 1.25rem;
		gap: 2rem;
	}

	input {
		width: 20rem;
	}
	/* TODO Container Query */
	input,
	button {
		font-size: inherit;
		font-family: inherit;
		border: none;
		background-color: #2d303b;
		color: inherit;
		padding: 0.25rem 0.5rem;
		border-radius: 0.25rem;
	}

	input:focus,
	input:hover,
	button:focus,
	button:hover {
		outline: none;
		background-color: #3d4150;
	}

	table {
		margin-bottom: 4rem;
		min-height: 0;
	}

	tbody {
		list-style: none;
		padding: 0;
		width: auto;
		overflow-y: scroll;
		overflow-x: hidden;
	}

	/* Scroll Bar */
	tbody::-webkit-scrollbar-track {
		background-color: #191b1f;
	}

	tbody::-webkit-scrollbar {
		width: 10px;
		background-color: #191b1f;
	}

	tbody::-webkit-scrollbar-thumb {
		background-color: #2d303b;
	}

	table {
		box-shadow: 0 14px 28px rgba(0, 0, 0, 0.25), 0 10px 10px rgba(0, 0, 0, 0.22);
		border-radius: 1rem;
	}

	thead {
		color: black;
		position: relative;
		z-index: 1;
		margin-right: 10px;
	}

	thead::after {
		content: '';
		display: block;
		background-color: #0fba81;
		border-radius: 0.25rem 0.25rem 0 0;
		inset: 0;
		position: absolute;
		z-index: -1;
		right: -10px;
	}

	table {
		display: flex;
		flex-flow: column;
		height: 100%;
		width: 100%;

		position: relative;
		border-radius: 0.5rem;
	}

	thead {
		flex: 0;
		border-radius: 0.25rem 0.25rem 0 0;
	}

	tbody {
		flex: auto;
		display: block;
		overflow-y: scroll;
		border-radius: 0 0 0.25rem 0.25rem;
	}

	tbody tr {
		width: 100%;
		background-color: var(--table-row-background-color);
		box-sizing: border-box;
		border-bottom: 1px solid #1d1f26;
		transition: background 0.1s ease-in-out;
	}

	tbody tr:hover {
		background-color: var(--table-row-background-color-hover);
	}

	td {
		padding: 0.25rem 0.5rem;
		box-sizing: border-box;
		text-overflow: ellipsis;
		overflow: hidden;
		white-space: nowrap;
	}

	thead,
	tbody tr {
		display: table;
		table-layout: fixed;
		box-sizing: border-box;
	}

	th {
		text-align: left;
		padding: 0.5rem;
	}

	td.topic {
		color: #0fba81;
	}

	.topic {
		width: 10%;
	}

	.timestamp {
		width: 20%;
		/* color:  */
	}

	td:focus {
		background: var(--table-row-background-color-hover);
		outline: 1px dashed #ffffff44;
	}

	.hitBottom::after {
		content: '';
		display: block;
		background-color: #0fba81;
		border-radius: 0 0 0.25rem 0.25rem;
		position: absolute;
		height: 5px;
		bottom: 0;
		width: 100%;
	}

	th details form {
		font-size: 1rem;
		position: absolute;
		padding: 0.5rem;
		border-radius: 0.25rem;
		margin-top: 1rem;
		display: flex;
		align-items: center;
		gap: 1rem;

		background-color: #0fba81;
		box-shadow: 0 10px 20px rgba(0, 0, 0, 0.19), 0 6px 6px rgba(0, 0, 0, 0.23);
	}

	th details form input {
		color: white;
	}

	.filtered {
		text-decoration: underline;
	}

	summary {
		cursor: pointer;
	}
</style>
