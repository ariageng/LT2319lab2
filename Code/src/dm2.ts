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

/* Menu definition */
interface Menu {
  [index: string]: { food?: string; drink?: string };
}
const menu: Menu = { // This is the menu object that contains the food and drink options
  burger: { food: "Wax burger" },
  french_fries: { food: "Wax fries" },
  coke: { drink: "Wax coke" },
  milkshake: { drink: "Wax milkshake" },
};

/* Order definition */ 
interface Order {
  food?: string;
  drink?: string;
}


/* Message */
interface Message { // This is the type of a single message
  role: "assistant" | "user" | "system";
  content: string;
}


interface MyDMContext extends DMContext {
  noinputCounter: number;
  availableModels?: string[];
  messages: Message[]; // This is the type of the messages array; the type of messages is a list
  lastResponse?: string;
  orders: Order[]; // This is the type of the orders array; the type of orders is a list
}

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
    fetch_completion: fromPromise(async ({input} :{input: { messages: Message[]}}) => {
      const lastMessageContent = input.messages[input.messages.length - 1]?.content || ""; // get the last message content
      console.log("Last message content:", lastMessageContent);

      const body = {
        model: "llama3.1",
        stream: false,
        temperature: 0.1,
        //this is the last message in the array of messages
        //messages: input.messages,
        prompt: `
          You are a virtual assistant taking a fast-food order. Extract the intent and entities from the user's latest input: "${lastMessageContent}" and respond using JSON.
          Example response:
          {
            intent: "order",
            entities: {
              food: "1 burger",
              drink: "2 cokes"
            }
          }
          Valid intents are:
          1. "order" (when ordering food or drink)
          2. "ask_for_menu" (when asking for the menu)
          3. "others" (for anything else)
          Ensure that you reply with only JSON, and do not include any additional text or explanations.
          If no order or menu is requested, respond with:
          {
            intent: "others",
            entities: null
          }.`
        ,
        format: "json",
      };

      
      console.log("Request body:", JSON.stringify(body, null, 2)); // 这里的body 是一个object，包含了model和messages
      
      try {
        const response = await fetch("http://localhost:11434/api/generate", {
          method: "POST",
          body: JSON.stringify(body), // is the prompt the last message in the array of messages? 
        }); //stringify converts a JavaScript object or value to a JSON string

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        console.log("API Response:", response);

        const textResponse = await response.text();
        console.log("Text API Response:", textResponse);

        // store the message part (including role and content) of the response in a variable
        const jsonResponse = JSON.parse(textResponse).response;
        console.log("JSON API Response:", jsonResponse);
      
        return jsonResponse;
      } catch (error) {
        console.error("Fetch completion error:", error);
        throw error; // Re-throw to be caught by XState
      }
    }),
    fetch_attitude: fromPromise(async ({input} :{input: { messages: Message[]}}) => {
      // get the last message content, send it to the model, and get the response
      // if the response is positive, return "positive"
      // if the response is negative, return "negative"
      const lastMessageContent = input.messages[input.messages.length - 1]?.content || ""; // get the last message content
      console.log("Last message content:", lastMessageContent);

      const body = {
        model: "llama3.1",
        stream: false,
        temperature: 0.1,
        prompt: `
          You are a virtual attitude detector. Determine the attitude of the user based on their latest input: "${lastMessageContent}" and respond with either "positive" or "negative" nothing else.`,
        };

      console.log("Request body:", JSON.stringify(body, null, 2)); 
      
      try {
        const response = await fetch("http://localhost:11434/api/generate", {
          method: "POST",
          body: JSON.stringify(body), 
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        console.log("API Response:", response);

        const textResponse = await response.text();
        console.log("Text API Response:", textResponse);

        const jsonResponse = JSON.parse(textResponse).response;
        console.log("JSON API Response:", jsonResponse);
      
        return jsonResponse;
      } catch (error) {
        console.error("Fetch attitude error:", error);
        throw error; // Re-throw to be caught by XState
      }
    }),
  },
}).createMachine({
  context: ({ spawn }) => ({ // what is the grammar here? Spawn is a function that takes a machine and returns an actor ref
    count: 0, // this was defined in the context type
    ssRef: spawn(speechstate, { input: settings }), 
    noinputCounter: 0,
    messages: [], // this was defined in the context type
    orders: [], // this was defined in the context type
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
                assign(({ event, context }) => { // here event is the output of the fetch_completion actor
                  // json response from the API:JSON API Response: {
                  //   "intent": "order",
                  //   "entities": {
                  //     "food": "2 burgers",
                  //     "drink": "1 coke"
                  //   }
                  // }
                  let output;
                  try {
                    output = JSON.parse(event.output); // parse the output of the fetch_completion actor
                    console.log("Parsed output:", output);
                  } catch (error) {
                    console.error("Error parsing output:", error);
                  }

                  const intent = output.intent; // get the intent from the output
                  const entities = output.entities; // get the entities from the output
                  console.log("Intent:", intent);
                  console.log("Entities:", entities);

                  // store the orders if the intent is "order" but the orders are empty at the beginning
                  let newOrders : Order[] = [...context.orders]; // copy the orders from the context

                  // if intent is "order"
                  if (intent === "order") {
                    // if entities.food exists, add it to the orders array
                    if (entities.food /*&& (entities.food in menu.keys)*/) { // check if the food is in the menu object
                      // get the right name of the food from the menu object
                      
                      console.log("Adding food to order:", entities.food);
                      newOrders.push({food: entities.food});
                    }
                    // if entities.drink exists, add it to the orders array
                    // check if any of the drinks in the menu is involved in the order
                    if (entities.drink /*&& (entities.drink in menu.keys)*/) {
                      console.log("Adding drink to order:", entities.drink);
                      newOrders.push({drink: entities.drink});
                    }
                    
                    // if no foor or drink is in the menu, return "I don't understand"
                    // if (newOrders.length === 0) {
                    //   return {
                    //     lastResponse: `Sorry, we don't have ${entities.food} or ${entities.drink}.`,
                    //     messages: [...context.messages, {role: "assistant", content: `Sorry, we don't have ${entities.food} or ${entities.drink}.`}],
                    //   };
                    // }

                    return {
                      orders: [...newOrders],
                      lastResponse: `You ordered ${entities.food} and ${entities.drink}.`,
                      messages: [...context.messages, {role: "assistant", content: `You ordered ${entities.food} and ${entities.drink}.`}],
                    };

                  // if intent is "ask_for_menu"
                  } else if (intent === "ask_for_menu") {
                    console.log("Asking for menu");
                    // if entities is empty, add the menu to the lastResponse
                    return {
                      lastResponse: `The menu is: ${Object.values(menu).map((item) => Object.values(item)[0]).join(", ")}.`,
                      messages: [...context.messages, {role: "assistant", content: `The menu is: ${Object.values(menu).map((item) => Object.values(item)[0]).join(", ")}.`}],
                    };
                  
                  // if intent is "others", reply "I don't understand"
                  }
                  console.log("can't recognize intent");
                  return {
                    lastResponse: `I don't understand.`,
                    messages: [...context.messages, {role: "assistant", content: `I don't understand.`}],
                  };


                }), 
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
            params: ({}) => ({
              value: `Welcome to Wax Burger! What would you like to order?`, 
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
                //{type: "logUtterance"},
                //{type: "logContext"}, 
              ],
            },
            //SPEAK_COMPLETE: "#DM.Done", 
          },
        },
        Response: {
          entry: {
            type: "speechstate_speak",
            params: ({ context }) => ({
              value: context.lastResponse!, 
            }),
          },
          on: { SPEAK_COMPLETE: "Checkstate" },
        },
        Checkstate: {
          // if there is order, confirm the order
          // if there is no order, prompt again
          // if the last response is "I don't understand", prompt again
          // if the last response is the menu, prompt again
          always: [
            { guard: ({ context }) => context.orders.length > 0, target: "Confirm" },
            { guard: ({ context }) => context.lastResponse === "I don't understand.", target: "Prompt" },
            { guard: ({ context }) => context.lastResponse === `The menu is: ${Object.values(menu).map((item) => Object.values(item)[0]).join(", ")}.`, target: "Prompt" },
            { target: "Prompt" },
          ],
        },
        Confirm: {
          entry: {
            type: "speechstate_speak",
            params: ({ context }) => ({
              value: `You ordered ${context.orders.map((item) => Object.values(item)[0]).join(", ")}. Is that correct?`, 
            }),
          },
          on: { SPEAK_COMPLETE: "Listen_for_attitude" },
        },
        Listen_for_attitude: {
          entry: {
            type: "speechstate_listen",
          },
          on: {
            RECOGNISED: {
              target: "Fetch_Attitude",
              actions: [
                {type: "storeUtterance"},
                //{type: "logUtterance"},
                //{type: "logContext"}, 
              ],
            },
          },
        },
        Fetch_Attitude: {
          invoke: {
            src: "fetch_attitude",
            input: ({ context }) => ({ messages: context.messages }),
            onDone: [
              {
                guard: ({ event }) => event.output === "Positive" || event.output === "positive",
                target: "Done",
              },
              {
                guard: ({ event }) => event.output === "Negative" || event.output === "negative",
                target: "Prompt",
              },
            ],
            onError: {
              actions: () => console.error("no attitude available"),
            },
          },
        },
        Done: {
          entry: {
            type: "speechstate_speak",
            params: ({ }) => ({
              value: `Thank you for your order!`, 
            }),
          },
          on: {
            CLICK: "#DM.PromptAndAsk",
          },
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
