import { AnyActorRef, assign, createActor, fromPromise, log, setup } from "xstate";
import { speechstate, SpeechStateExternalEvent } from "speechstate";
import { createBrowserInspector } from "@statelyai/inspect";
import { KEY } from "./azure";

const inspector = createBrowserInspector();

const azureCredentials = {
  endpoint:
    "https://northeurope.api.cognitive.microsoft.com/sts/v1.0/issuetoken",
  key: KEY,
};

const settings = {
  azureRegion: "northeurope",
  azureCredentials: azureCredentials,
  asrDefaultCompleteTimeout: 0,
  asrDefaultNoInputTimeout: 5000,
  locale: "en-US",
  ttsDefaultVoice: "en-US-DavisNeural",
};

// /* Grammar definition */
// interface Grammar {
//   [index: string]: { person?: string; day?: string; time?: string };
// }
// const grammar: Grammar = {
//   vlad: { person: "Vladislav Maraev" },
//   aya: { person: "Nayat Astaiza Soriano" },
//   rasmus: { person: "Rasmus Blanck" },
//   monday: { day: "Monday" },
//   tuesday: { day: "Tuesday" },
//   "10": { time: "10:00" },
//   "11": { time: "11:00" },
// };

/* Message */
interface Message { // This is the type of a single message
  role: "assistant" | "user" | "system";
  content: string;
}
// /* Helper functions */
// function isInGrammar(utterance: string) {
//   return utterance.toLowerCase() in grammar;
// }

// function getPerson(utterance: string) {
// return (grammar[utterance.toLowerCase()] || {}).person;
// }

interface MyDMContext extends DMContext {
  noinputCounter: number;
  availableModels?: string[];
  messages: Message[]; // This is the type of the messages array; the type of messages is a list
  lastResponse?: string;}
interface DMContext {
  count: number;
  ssRef: AnyActorRef;
}
const dmMachine = setup({
  types: {} as {
    context: MyDMContext; // Define the context type of the machine here
    events: SpeechStateExternalEvent | { type: "CLICK" };
  },
  guards: {
    noinputCounterMoreThanOne: ({ context }) => {
      if (context.noinputCounter > 1) {
        return true;
      } else {
        return false;
      }
    },
  },
  actions: {
    /* define your actions here */
    speechstate_prepare: ({ context }) =>
      context.ssRef.send({ type: "PREPARE" }),
    speechstate_listen: ({ context }) => context.ssRef.send({ type: "LISTEN" }),
    speechstate_speak: ({ context }, params: { value: string }) =>
      context.ssRef.send({ type: "SPEAK", value: { utterance: params.value } }),
    debug: () => console.debug("blabla"),
    //logContext: ({ context }) => console.log("logging context:",context),
    assign_noinputCounter: assign(({ context }, params?: { value: number }) => {
      if (!params) {
        return { noinputCounter: context.noinputCounter + 1 };
      }
      return { noinputCounter: context.noinputCounter + params.value };
    }),
    storeUtterance: assign(({ context, event }) => { 
      if (event.type === "RECOGNISED") {
        // log "Storing utterance"
        console.log("(Storing user utterance...)");
        const currentUtterance = event.value[0].utterance;
        return {
          messages: [ // there is a bug here, messages is not defined
            ...context.messages, 
            { role: "user" as const, content: currentUtterance } // there is a bug here, currentUtterance is not defined
          ]
        };
      }
      return { messages: context.messages }; // Return existing messages to avoid undefined
    }),
    logUtterance: ({event}) => {
      if (event.type === "RECOGNISED") {
        console.log("User utterance:",event.value[0].utterance);
      } else { // if not, log "no new utterance"
        return console.log("No new utterance");
      }
    },
  },
  actors: { // Actors are for side effects, like fetching data, or interacting with other services
    get_ollama_models: fromPromise<any, null>(async () => { 
      return fetch("http://localhost:11434/api/tags").then((response) =>
        response.json()
      );
    }),
    // this sends the messages to the server and gets the textMessage
    fetch_completion: fromPromise<any, {messages: Message[]}>(async (
      {input} :{input: { messages: Message[]} // input is the messages from the context
      }) => {
      // this actor takes in the messages from the context and sends them to the server
      const body = {
        model: "llama3.1",
        stream: false,
        //this is the last message in the array of messages
        messages: input.messages 
      };

      console.log("Request body:", JSON.stringify(body, null, 2)); // 这里的body 是一个object，包含了model和messages
      
      try {
        const response = await fetch("http://localhost:11434/api/chat", {
          method: "POST",
          body: JSON.stringify(body), // body is the data that is sent to the server, including the model and the messages
        }); //stringify converts a JavaScript object or value to a JSON string

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const textResponse = await response.text();
        // console.log("Text API Response:", textResponse);

        // store the message part (including role and content) of the response in a variable
        const textMessage = JSON.parse(textResponse).message;
        // console.log("Text message:", textMessage); // store the message in a variable
      
        return textMessage;
      } catch (error) {
        console.error("Fetch completion error:", error);
        throw error; // Re-throw to be caught by XState
      }
    }),
  },
}).createMachine({
  context: ({ spawn }) => ({ // what is the grammar here? Spawn is a function that takes a machine and returns an actor ref
    count: 0, // this was defined in the context type
    ssRef: spawn(speechstate, { input: settings }), 
    noinputCounter: 0,
    messages: [] // this was defined in the context type
    // moreStuff: {thingOne: 1, thingTwo: 2}
  }),
  id: "DM",
  initial: "Prepare",
  states: {
    Prepare: {
      entry: [{ type: "speechstate_prepare" }],
      on: { ASRTTS_READY: "WaitToStart" },
    },
    WaitToStart: {
      on: {
        CLICK: "PromptAndAsk",
      },
    },
    PromptAndAsk: {
      initial: "GetModels",
      states: {
        GetModels: {
          invoke: {
            src: "get_ollama_models",
            onDone: {
              target: "Prompt",
              actions: assign(({ event }) => {
                console.log(event.output);
                return {
                  availableModels: event.output.models.map((m: any) => m.name),
                };
              }),
            },
            onError: {
              actions: () => console.error("no models available"),
            },
          },
        },
        Fetch_Completion: {
          invoke: { // actor是用来处理side effects的，比如fetch data，或者和其他服务交互
            src: "fetch_completion", // use the fetch_completion actor to fetch the completion aka textMessage
            // and pass the textMessage to the context.messages and the lastResponse
            input: ({ context }) => ({ messages: context.messages }), 
            // the input is the messages from the context
            // when the fetch_completion actor is done, go to the Response state
            onDone: {
              target: "Response", 
              actions: [
                // log the event and the context
                // log(({ event, context }) => console.log("Event:", event, "Context:", context)),
                // store the textMessage in the context.messages and lastResponse
                assign(({ event, context }) => ({ // here event is the output of the fetch_completion actor
                  lastResponse: event.output.content, // here event.data is the textMessage
                  messages: [
                    ...context.messages,
                    { role: "assistant", content: event.output.content },
                  ],
                })), 
                //log the last response
                ({ context }) => console.log("Last response:", context.lastResponse),
              ]
            },
            onError: {
              actions: () => console.error("no completion available"),
            },
          },
        },
        Prompt: {
          entry: {
            type: "speechstate_speak",
            params: ({ context }) => ({
              value: `Hello world! Available models are: ${context.availableModels!.join(
                " "
              )}`,
            }),
          },
          on: { 
            SPEAK_COMPLETE: { 
              target: "Listen" 
            },
          },
            // *prompt之后记录历史，也就是在这里target的后面加actions，assign(({context}) => ({return {messages: [...context.messages, {role: "assistant", content: event.output.choices[0].message.content}]}}))
        },
        NoInput: {
          initial: "Choice",
          states: {
            Choice: {
              always: [
                { guard: "noinputCounterMoreThanOne", target: "MoreThanOne" },
                { target: "LessThanOne" },
              ],
            },
            LessThanOne: {
              entry: {
                type: "speechstate_speak",
                params: { value: "I didn't hear you" },
              },
            },
            MoreThanOne: {
              entry: {
                type: "speechstate_speak",
                params: ({ context }) => {
                  return {
                    value: `I didn't hear you ${context.noinputCounter} times. Goodbye!`,
                  };
                },
              },
              on : {SPEAK_COMPLETE: "#DM.Done"},
            },
          },
          on: { SPEAK_COMPLETE: "Listen" },
        },
        Listen: {
          entry: {
            type: "speechstate_listen",
          },
          on: {
            ASR_NOINPUT: {
              target: "NoInput",
              actions: { type: "assign_noinputCounter" },
            },
            RECOGNISED: {
              target: "Fetch_Completion",
              actions: [
                {type: "storeUtterance"},
                //{type: "logUtterance"}, // "Hello"
                //{type: "logContext"}, 
              ],
            },
            SPEAK_COMPLETE: "#DM.Done", 
          },
        },
        Response: {
          entry: {
            type: "speechstate_speak",
            params: ({ context }) => ({
              value: context.lastResponse!, 
            }),
          },
          on: { SPEAK_COMPLETE: "Listen" },
        },
      },
    },
    Done: {
      on: {
        CLICK: "#DM.PromptAndAsk",
      },
    },
  },
});

const dmActor = createActor(dmMachine, {
  inspect: inspector.inspect,
}).start();

dmActor.subscribe((state) => {
  /* if you want to log some parts of the state */
  console.debug(state.context);
});

export function setupButton(element: HTMLElement) {
  element.addEventListener("click", () => {
    dmActor.send({ type: "CLICK" });
  });
  dmActor.getSnapshot().context.ssRef.subscribe((snapshot) => {
    const meta = Object.values(snapshot.getMeta())[0];
    element.innerHTML = `${(meta as any).view}`;
  });
}
